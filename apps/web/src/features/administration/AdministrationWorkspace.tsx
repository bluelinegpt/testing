import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../../api/api-client.js";
import type { CompanyUser, LoginResponse, Permission, Role } from "../../api/contracts.js";
import { PageHeader } from "../../components/PageHeader.js";
import { formatDate } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";
import { CompanyConfigurationWorkspace } from "../configuration/CompanyConfigurationWorkspace.js";
import { DashboardWorkspace, type DashboardDrillDown } from "../dashboard/DashboardWorkspace.js";
import { OperationsWorkspace, type OperationsView } from "../operations/OperationsWorkspace.js";
import { SupportWorkspace } from "../support/SupportWorkspace.js";

type View = "dashboard" | "operations" | "configuration" | "users" | "roles" | "support";

export function AdministrationWorkspace({
  api,
  embedded = false,
  initialView = "dashboard",
  session,
  onLogout,
}: {
  api: ApiClient;
  embedded?: boolean;
  initialView?: View;
  session: LoginResponse;
  onLogout?: () => Promise<void>;
}) {
  const { i18n, t } = useTranslation();
  const [view, setView] = useState<View>(initialView);
  const [operationsView, setOperationsView] = useState<OperationsView>("orders");
  const [users, setUsers] = useState<readonly CompanyUser[]>([]);
  const [roles, setRoles] = useState<readonly Role[]>([]);
  const [permissions, setPermissions] = useState<readonly Permission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [roleEditor, setRoleEditor] = useState<Role | "new">();
  const [roleUser, setRoleUser] = useState<CompanyUser>();
  const [deactivateUser, setDeactivateUser] = useState<CompanyUser>();

  useEffect(() => setView(initialView), [initialView]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [loadedUsers, loadedRoles, loadedPermissions] = await Promise.all([
        api.get<readonly CompanyUser[]>("users"),
        api.get<readonly Role[]>("roles"),
        api.get<readonly Permission[]>("roles/permissions"),
      ]);
      setUsers(loadedUsers);
      setRoles(loadedRoles);
      setPermissions(loadedPermissions);
    } catch {
      setError(t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => void load(), [load]);

  const roleNames = useMemo(() => new Map(roles.map((role) => [role.id, role.name])), [roles]);
  const locale = normalizeLocale(i18n.resolvedLanguage);

  const unlock = async (user: CompanyUser) => {
    try {
      await api.post<void>(`users/${user.accountId}/unlock`);
      await load();
    } catch {
      setError(t("users.actionFailed"));
    }
  };

  return (
    <main className={`admin-layout${embedded ? " embedded-administration" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-company">
          <span>{t("workspace.company")}</span>
          <strong>{session.identity.username}</strong>
        </div>
        <nav aria-label={t("workspace.navigation")} className="side-nav">
          <button
            aria-current={view === "dashboard" ? "page" : undefined}
            onClick={() => setView("dashboard")}
            type="button"
          >
            {t("dashboard.title")}
          </button>
          <button
            aria-current={view === "operations" ? "page" : undefined}
            onClick={() => setView("operations")}
            type="button"
          >
            {t("operations.title")}
          </button>
          <button
            aria-current={view === "configuration" ? "page" : undefined}
            onClick={() => setView("configuration")}
            type="button"
          >
            {t("configuration.title")}
          </button>
          <button
            aria-current={view === "users" ? "page" : undefined}
            onClick={() => setView("users")}
            type="button"
          >
            {t("users.title")}
          </button>
          <button
            aria-current={view === "roles" ? "page" : undefined}
            onClick={() => setView("roles")}
            type="button"
          >
            {t("roles.title")}
          </button>
          <button
            aria-current={view === "support" ? "page" : undefined}
            onClick={() => setView("support")}
            type="button"
          >
            {t("support.title")}
          </button>
        </nav>
        <button
          className="button button-secondary logout-button"
          onClick={() => void onLogout?.()}
          type="button"
        >
          {t("auth.logout")}
        </button>
      </aside>

      <section className="admin-content">
        {view === "dashboard" ? (
          <DashboardWorkspace
            api={api}
            onDrillDown={(target: DashboardDrillDown) => {
              setOperationsView(target);
              setView("operations");
            }}
          />
        ) : view === "operations" ? (
          <OperationsWorkspace api={api} initialView={operationsView} />
        ) : view === "configuration" ? (
          <CompanyConfigurationWorkspace api={api} view="general" />
        ) : view === "support" ? (
          <SupportWorkspace api={api} />
        ) : (
          <>
            {error === undefined ? null : (
              <div className="alert alert-error" role="alert">
                {error}
              </div>
            )}
            {view === "users" ? (
              <>
                <PageHeader
                  actions={
                    <>
                      <button
                        className="button button-primary"
                        disabled
                        title={t("users.createUnavailable")}
                        type="button"
                      >
                        {t("users.create")}
                      </button>
                      <button
                        className="button button-secondary"
                        onClick={() => void load()}
                        type="button"
                      >
                        {t("common.refresh")}
                      </button>
                    </>
                  }
                  eyebrow={t("workspace.administration")}
                  title={t("users.title")}
                />
                <div className="data-surface">
                  <table>
                    <thead>
                      <tr>
                        <th>{t("users.user")}</th>
                        <th>{t("users.status")}</th>
                        <th>{t("users.roles")}</th>
                        <th>{t("users.lastLogin")}</th>
                        <th>
                          <span className="sr-only">{t("common.actions")}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((user) => (
                        <tr key={user.accountId}>
                          <td>
                            <strong>
                              {locale === "ar"
                                ? (user.nameAr ?? user.nameEn ?? user.username)
                                : (user.nameEn ?? user.username)}
                            </strong>
                            <span className="cell-secondary">{user.username}</span>
                          </td>
                          <td>
                            <span className={`status status-${user.status}`}>
                              {t(`status.${user.status}`)}
                            </span>
                            {user.lockedUntil === null ? null : (
                              <span className="cell-secondary">{t("status.locked")}</span>
                            )}
                          </td>
                          <td>
                            {user.roleIds.length === 0 ? (
                              <span className="muted">{t("users.noRoles")}</span>
                            ) : (
                              user.roleIds.map((id) => roleNames.get(id) ?? id).join(", ")
                            )}
                          </td>
                          <td>
                            {user.lastLoginAt === null ? (
                              <span className="muted">{t("common.never")}</span>
                            ) : (
                              formatDate(user.lastLoginAt, locale)
                            )}
                          </td>
                          <td>
                            <div className="row-actions">
                              <button onClick={() => setRoleUser(user)} type="button">
                                {t("users.assignRoles")}
                              </button>
                              <button
                                disabled={user.status === "disabled"}
                                onClick={() => void unlock(user)}
                                type="button"
                              >
                                {t("users.unlock")}
                              </button>
                              <button
                                className="danger-link"
                                disabled={
                                  user.status === "disabled" ||
                                  user.accountId === session.identity.id
                                }
                                onClick={() => setDeactivateUser(user)}
                                type="button"
                              >
                                {t("users.deactivate")}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {!loading && users.length === 0 ? (
                        <tr>
                          <td className="empty-state" colSpan={5}>
                            {t("users.empty")}
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                  {loading ? <div className="loading-row">{t("common.loading")}</div> : null}
                </div>
              </>
            ) : (
              <>
                <PageHeader
                  actions={
                    <button
                      className="button button-primary"
                      onClick={() => setRoleEditor("new")}
                      type="button"
                    >
                      {t("roles.create")}
                    </button>
                  }
                  eyebrow={t("workspace.administration")}
                  title={t("roles.title")}
                />
                <div className="role-grid">
                  {roles.map((role) => (
                    <article className="role-card" key={role.id}>
                      <div className="role-card-heading">
                        <div>
                          <h2>{role.name}</h2>
                          <code>{role.code}</code>
                        </div>
                        <span className={`status status-${role.isActive ? "active" : "disabled"}`}>
                          {role.isActive ? t("status.active") : t("status.disabled")}
                        </span>
                      </div>
                      <p>{t("roles.permissionCount", { count: role.permissions.length })}</p>
                      <button
                        className="button button-secondary"
                        disabled={role.isSystem}
                        onClick={() => setRoleEditor(role)}
                        type="button"
                      >
                        {role.isSystem ? t("roles.system") : t("common.edit")}
                      </button>
                    </article>
                  ))}
                  {!loading && roles.length === 0 ? (
                    <div className="empty-state">{t("roles.empty")}</div>
                  ) : null}
                </div>
              </>
            )}
          </>
        )}
      </section>

      {roleEditor === undefined ? null : (
        <RoleEditor
          api={api}
          permissions={permissions}
          role={roleEditor}
          onClose={() => setRoleEditor(undefined)}
          onSaved={async () => {
            setRoleEditor(undefined);
            await load();
          }}
        />
      )}
      {roleUser === undefined ? null : (
        <RoleAssignment
          api={api}
          roles={roles.filter((role) => role.isActive)}
          user={roleUser}
          onClose={() => setRoleUser(undefined)}
          onSaved={async () => {
            setRoleUser(undefined);
            await load();
          }}
        />
      )}
      {deactivateUser === undefined ? null : (
        <DeactivateUser
          api={api}
          user={deactivateUser}
          onClose={() => setDeactivateUser(undefined)}
          onSaved={async () => {
            setDeactivateUser(undefined);
            await load();
          }}
        />
      )}
    </main>
  );
}

function RoleEditor({
  api,
  permissions,
  role,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  permissions: readonly Permission[];
  role: Role | "new";
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(role === "new" ? "" : role.name);
  const [code, setCode] = useState(role === "new" ? "" : role.code);
  const [selected, setSelected] = useState<readonly string[]>(
    role === "new" ? [] : role.permissions,
  );
  const [isActive, setIsActive] = useState(role === "new" ? true : role.isActive);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const body = { isActive, name, permissions: selected };
      if (role === "new") await api.post<Role>("roles", { ...body, code });
      else await api.patch<Role>(`roles/${role.id}`, body);
      await onSaved();
    } catch {
      setError(t("common.saveFailed"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <section
        aria-labelledby="role-editor-title"
        aria-modal="true"
        className="modal"
        role="dialog"
      >
        <div className="modal-heading">
          <h2 id="role-editor-title">{role === "new" ? t("roles.create") : t("roles.edit")}</h2>
          <button
            aria-label={t("common.close")}
            className="close-button"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          {error === undefined ? null : <div className="alert alert-error">{error}</div>}
          <div className="form-grid">
            <label className="field">
              <span>{t("roles.name")}</span>
              <input onChange={(event) => setName(event.target.value)} required value={name} />
            </label>
            <label className="field">
              <span>{t("roles.code")}</span>
              <input
                disabled={role !== "new"}
                onChange={(event) => setCode(event.target.value.toLowerCase())}
                pattern="[a-z][a-z0-9_]{1,63}"
                required
                value={code}
              />
            </label>
          </div>
          <fieldset className="permission-list">
            <legend>{t("roles.permissions")}</legend>
            {permissions.map((permission) => (
              <label key={permission.code}>
                <input
                  checked={selected.includes(permission.code)}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selected, permission.code]
                        : selected.filter((code) => code !== permission.code),
                    )
                  }
                  type="checkbox"
                />
                <span>
                  <strong>{permission.code}</strong>
                  <small>{permission.description}</small>
                </span>
              </label>
            ))}
          </fieldset>
          {role === "new" ? null : (
            <label className="toggle-row">
              <input
                checked={isActive}
                onChange={(event) => setIsActive(event.target.checked)}
                type="checkbox"
              />
              <span>{t("roles.active")}</span>
            </label>
          )}
          <div className="modal-actions">
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.cancel")}
            </button>
            <button className="button button-primary" disabled={saving} type="submit">
              {saving ? t("common.working") : t("common.save")}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function RoleAssignment({
  api,
  roles,
  user,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  roles: readonly Role[];
  user: CompanyUser;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<readonly string[]>(user.roleIds);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await api.put<void>(`users/${user.accountId}/roles`, { roleIds: selected });
      await onSaved();
    } catch {
      setError(t("users.roleSaveFailed"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <section
        aria-labelledby="assign-title"
        aria-modal="true"
        className="modal modal-small"
        role="dialog"
      >
        <div className="modal-heading">
          <h2 id="assign-title">{t("users.assignRoles")}</h2>
          <button
            aria-label={t("common.close")}
            className="close-button"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>
        <p className="modal-subtitle">{user.nameEn ?? user.username}</p>
        {error === undefined ? null : <div className="alert alert-error">{error}</div>}
        <div className="selection-list">
          {roles.map((role) => (
            <label key={role.id}>
              <input
                checked={selected.includes(role.id)}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? [...selected, role.id]
                      : selected.filter((id) => id !== role.id),
                  )
                }
                type="checkbox"
              />
              <span>{role.name}</span>
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            {t("common.cancel")}
          </button>
          <button
            className="button button-primary"
            disabled={saving}
            onClick={() => void save()}
            type="button"
          >
            {saving ? t("common.working") : t("common.save")}
          </button>
        </div>
      </section>
    </div>
  );
}

function DeactivateUser({
  api,
  user,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  user: CompanyUser;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      await api.post<void>(`users/${user.accountId}/deactivate`, { reason });
      await onSaved();
    } catch {
      setError(t("users.actionFailed"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <section
        aria-labelledby="deactivate-title"
        aria-modal="true"
        className="modal modal-small"
        role="dialog"
      >
        <div className="modal-heading">
          <h2 id="deactivate-title">{t("users.deactivate")}</h2>
          <button
            aria-label={t("common.close")}
            className="close-button"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>
        <p className="modal-subtitle">{user.nameEn ?? user.username}</p>
        <form onSubmit={(event) => void submit(event)}>
          {error === undefined ? null : <div className="alert alert-error">{error}</div>}
          <label className="field">
            <span>{t("users.reason")}</span>
            <textarea
              minLength={3}
              onChange={(event) => setReason(event.target.value)}
              required
              rows={4}
              value={reason}
            />
          </label>
          <div className="modal-actions">
            <button className="button button-secondary" onClick={onClose} type="button">
              {t("common.cancel")}
            </button>
            <button className="button button-danger" disabled={saving} type="submit">
              {saving ? t("common.working") : t("users.deactivate")}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
