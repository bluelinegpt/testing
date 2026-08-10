import {
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  KeyRound,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  UnlockKeyhole,
  UserRoundCog,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import type {
  AdministrationAuditEvent,
  AdministrationPage,
  CompanyUser,
  EmployeeOption,
  Permission,
  Role,
  RoleDetails,
  UserDetails,
} from "../../api/contracts.js";
import { Modal } from "../../components/Modal.js";
import { PageHeader } from "../../components/PageHeader.js";
import { isUaeMobile, normalizeUaeMobile } from "../../domain/uae-mobile.js";
import { LegacyBusinessLinkSyncPanel } from "./LegacyBusinessLinkSyncPanel.js";

export function UsersConfigurationWorkspace({
  api,
  initiallyCreating = false,
  onNavigate,
}: {
  api: ApiClient;
  initiallyCreating?: boolean;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [accountKind, setAccountKind] = useState("all");
  const [employee, setEmployee] = useState("all");
  const [roleId, setRoleId] = useState("");
  const [sortOrder, setSortOrder] = useState("name:asc");
  const [data, setData] = useState<AdministrationPage<CompanyUser>>();
  const [roles, setRoles] = useState<readonly Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(initiallyCreating);
  const [temp, setTemp] = useState<{
    temporaryPassword: string;
    temporaryPasswordExpiresAt: string;
  }>();
  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [sort, direction] = sortOrder.split(":") as [string, "asc" | "desc"];
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        status,
        accountKind,
        employee,
        sort,
        direction,
      });
      if (search.trim()) params.set("search", search.trim());
      if (roleId) params.set("roleId", roleId);
      const [users, rolePage] = await Promise.all([
        api.get<AdministrationPage<CompanyUser>>(`users?${params}`),
        api.get<AdministrationPage<Role>>("roles?page=1&pageSize=100&status=all"),
      ]);
      setData(users);
      setRoles(rolePage.items);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("common.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [accountKind, api, employee, page, pageSize, roleId, search, sortOrder, status, t]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="configuration-surface administration-surface">
      <PageHeader
        eyebrow={t("nav.configuration")}
        title={t("userAdmin.usersTitle")}
        actions={
          <button className="button button-primary" onClick={() => setCreating(true)} type="button">
            <Plus size={17} />
            {t("userAdmin.createUser")}
          </button>
        }
      />
      <div className="admin-filter-bar">
        <label className="admin-search">
          <Search size={17} />
          <input
            aria-label={t("common.search")}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder={t("userAdmin.searchUsers")}
            value={search}
          />
        </label>
        <select
          aria-label={t("common.status")}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          value={status}
        >
          <option value="all">{t("userAdmin.allStatuses")}</option>
          <option value="active">{t("userAdmin.active")}</option>
          <option value="disabled">{t("userAdmin.disabled")}</option>
          <option value="locked">{t("userAdmin.locked")}</option>
        </select>
        <select
          aria-label={t("userAdmin.accountKind")}
          onChange={(e) => {
            setAccountKind(e.target.value);
            setPage(1);
          }}
          value={accountKind}
        >
          <option value="all">{t("userAdmin.allAccountKinds")}</option>
          <option value="company_user">{t("userAdmin.accountKinds.company_user")}</option>
          <option value="driver">{t("userAdmin.accountKinds.driver")}</option>
          <option value="trader">{t("userAdmin.accountKinds.trader")}</option>
        </select>
        <select
          aria-label={t("userAdmin.sort")}
          onChange={(event) => {
            setSortOrder(event.target.value);
            setPage(1);
          }}
          value={sortOrder}
        >
          <option value="name:asc">{t("userAdmin.nameAscending")}</option>
          <option value="username:asc">{t("userAdmin.usernameAscending")}</option>
          <option value="lastLoginAt:desc">{t("userAdmin.lastLoginSort")}</option>
          <option value="createdAt:desc">{t("userAdmin.newest")}</option>
        </select>
        <select
          aria-label={t("userAdmin.employee")}
          onChange={(e) => {
            setEmployee(e.target.value);
            setPage(1);
          }}
          value={employee}
        >
          <option value="all">{t("userAdmin.allLinks")}</option>
          <option value="linked">{t("userAdmin.linked")}</option>
          <option value="unlinked">{t("userAdmin.notLinked")}</option>
        </select>
        <select
          aria-label={t("userAdmin.roleFilter")}
          onChange={(e) => {
            setRoleId(e.target.value);
            setPage(1);
          }}
          value={roleId}
        >
          <option value="">{t("userAdmin.roleFilter")}</option>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </select>
        <button
          className="icon-button"
          onClick={() => void load()}
          title={t("common.refresh")}
          type="button"
        >
          <RefreshCw size={18} />
        </button>
      </div>
      {error ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="table-frame">
        <table className="data-table admin-data-table">
          <thead>
            <tr>
              <th>{t("userAdmin.username")}</th>
              <th>{t("userAdmin.accountKind")}</th>
              <th>{t("common.name")}</th>
              <th>{t("userAdmin.email")}</th>
              <th>{t("userAdmin.employee")}</th>
              <th>{t("userAdmin.roles")}</th>
              <th>{t("common.status")}</th>
              <th>{t("userAdmin.lastLogin")}</th>
              <th>{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={9} className="empty-cell">
                  {t("common.loading")}
                </td>
              </tr>
            ) : data?.items.length === 0 ? (
              <tr>
                <td colSpan={9} className="empty-cell">
                  {t("userAdmin.noUsers")}
                </td>
              </tr>
            ) : (
              data?.items.map((user) => (
                <tr key={user.accountId}>
                  <td>
                    <strong>{user.username}</strong>
                    {user.forcePasswordChange ? (
                      <small className="table-note">{t("userAdmin.passwordRequired")}</small>
                    ) : null}
                  </td>
                  <td>{t(`userAdmin.accountKinds.${user.accountKind}`)}</td>
                  <td>{user.displayName}</td>
                  <td>
                    {user.email ?? "-"}
                    <small className="table-note">{user.mobileNumber ?? ""}</small>
                  </td>
                  <td>
                    {user.employeeName ?? t("userAdmin.notLinked")}
                    <small className="table-note">{user.employeeCode ?? ""}</small>
                  </td>
                  <td>
                    <div className="tag-list">
                      {user.roleNames.map((name) => (
                        <span className="tag" key={name}>
                          {name}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <Status value={user.status} />
                  </td>
                  <td>{dateTime(user.lastLoginAt, t("common.never"))}</td>
                  <td>
                    <button
                      className="button button-quiet"
                      onClick={() => onNavigate(`/configuration/users/${user.accountId}`)}
                      type="button"
                    >
                      {t("common.view")}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pagination
        page={page}
        pageSize={pageSize}
        total={data?.total ?? 0}
        onPage={setPage}
        onPageSize={(value) => {
          setPageSize(value);
          setPage(1);
        }}
      />
      <LegacyBusinessLinkSyncPanel api={api} />
      {creating ? (
        <UserForm
          api={api}
          roles={roles}
          onClose={() => setCreating(false)}
          onCreated={(result) => {
            setCreating(false);
            setTemp(result);
            void load();
          }}
        />
      ) : null}
      {temp ? <TemporaryPassword result={temp} onClose={() => setTemp(undefined)} /> : null}
    </section>
  );
}

export function UserDetailsWorkspace({
  api,
  accountId,
  onBack,
  onNavigate,
}: {
  api: ApiClient;
  accountId: string;
  onBack: () => void;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [user, setUser] = useState<UserDetails>();
  const [roles, setRoles] = useState<readonly Role[]>([]);
  const [tab, setTab] = useState("overview");
  const [modal, setModal] = useState<
    "edit" | "roles" | "disable" | "lock" | "reset" | "force" | "revoke"
  >();
  const [removingRole, setRemovingRole] = useState<{ id: string; name: string }>();
  const [temp, setTemp] = useState<{
    temporaryPassword: string;
    temporaryPasswordExpiresAt: string;
  }>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      const [u, r] = await Promise.all([
        api.get<UserDetails>(`users/${accountId}`),
        api.get<AdministrationPage<Role>>("roles?page=1&pageSize=100&status=all"),
      ]);
      setUser(u);
      setRoles(r.items);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("common.loadFailed"));
    }
  }, [accountId, api, t]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!user)
    return (
      <section className="configuration-surface">
        <button className="button button-quiet" onClick={onBack}>
          <ChevronLeft size={17} />
          {t("common.back")}
        </button>
        {error ? <div className="alert alert-error">{error}</div> : <p>{t("common.loading")}</p>}
      </section>
    );
  const simple = async (path: string, body?: unknown) => {
    try {
      await api.post<void>(path, body);
      setModal(undefined);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("userAdmin.actionFailed"));
    }
  };
  return (
    <section className="configuration-surface administration-surface">
      <button className="button button-quiet back-button" onClick={onBack} type="button">
        <ChevronLeft size={17} />
        {t("common.back")}
      </button>
      <PageHeader
        eyebrow={t("userAdmin.userDetails")}
        title={user.displayName}
        description={user.username}
        actions={
          <div className="heading-actions">
            <button className="button button-secondary" onClick={() => setModal("edit")}>
              <UserRoundCog size={17} />
              {t("userAdmin.editUser")}
            </button>
            {user.status === "disabled" ? (
              <button
                className="button button-secondary"
                onClick={() => void simple(`users/${accountId}/reactivate`)}
              >
                {t("userAdmin.reactivate")}
              </button>
            ) : (
              <button className="button button-danger" onClick={() => setModal("disable")}>
                <Ban size={17} />
                {t("userAdmin.disable")}
              </button>
            )}
            {user.status === "locked" ? (
              <button
                className="button button-secondary"
                onClick={() => void simple(`users/${accountId}/unlock`)}
              >
                <UnlockKeyhole size={17} />
                {t("userAdmin.unlock")}
              </button>
            ) : (
              <button className="button button-secondary" onClick={() => setModal("lock")}>
                <LockKeyhole size={17} />
                {t("userAdmin.lock")}
              </button>
            )}
          </div>
        }
      />
      {error ? <div className="alert alert-error">{error}</div> : null}
      <div className="detail-status-line">
        <Status value={user.status} />
        {user.forcePasswordChange ? (
          <span className="status-pill status-warning">{t("userAdmin.passwordRequired")}</span>
        ) : null}
        <span>{user.email}</span>
        <span>{user.mobileNumber ?? "-"}</span>
      </div>
      <div className="detail-tabs" role="tablist">
        {(
          [
            ["overview", "overview"],
            ["access", "access"],
            ["activity", "activity"],
            ["sessions", "sessions"],
            ["history", "history"],
          ] as const
        ).map(([id, key]) => (
          <button aria-selected={tab === id} key={id} onClick={() => setTab(id)} role="tab">
            {t(`userAdmin.${key}`)}
          </button>
        ))}
      </div>
      {tab === "overview" ? (
        <Overview onNavigate={onNavigate} user={user} />
      ) : tab === "access" ? (
        <Access
          user={user}
          onAssign={() => setModal("roles")}
          onRemoveRole={(role) => setRemovingRole(role)}
        />
      ) : tab === "activity" ? (
        <Activity user={user} onForce={() => setModal("force")} onReset={() => setModal("reset")} />
      ) : tab === "sessions" ? (
        <Sessions
          user={user}
          onRevoke={(id) => void simple(`users/${accountId}/sessions/${id}/revoke`, {})}
          onRevokeAll={() => setModal("revoke")}
        />
      ) : (
        <Audit events={user.audit} />
      )}
      {modal === "edit" ? (
        <UserForm
          api={api}
          editing={user}
          roles={roles}
          onClose={() => setModal(undefined)}
          onCreated={() => {}}
          onSaved={async () => {
            setModal(undefined);
            await load();
          }}
        />
      ) : null}
      {modal === "roles" ? (
        <RoleAssignment
          api={api}
          roles={roles}
          user={user}
          onClose={() => setModal(undefined)}
          onSaved={async () => {
            setModal(undefined);
            await load();
          }}
        />
      ) : null}
      {removingRole ? (
        <RemoveRoleDialog
          api={api}
          role={removingRole}
          user={user}
          onClose={() => setRemovingRole(undefined)}
          onRemoved={async () => {
            setRemovingRole(undefined);
            await load();
          }}
        />
      ) : null}
      {modal && ["disable", "lock", "reset", "force", "revoke"].includes(modal) ? (
        <ActionDialog
          action={modal}
          onClose={() => setModal(undefined)}
          onConfirm={async (reason) => {
            if (modal === "reset") {
              try {
                const result = await api.post<{
                  temporaryPassword: string;
                  temporaryPasswordExpiresAt: string;
                }>(`users/${accountId}/reset-password`, { reason });
                setModal(undefined);
                setTemp(result);
                await load();
              } catch (caught) {
                setError(caught instanceof ApiError ? caught.message : t("userAdmin.actionFailed"));
              }
            } else if (modal === "force")
              await simple(`users/${accountId}/force-password-change`, { required: true, reason });
            else if (modal === "revoke")
              await simple(`users/${accountId}/sessions/revoke-all`, {
                reason,
                preserveCurrentSession: accountId === user.accountId,
              });
            else await simple(`users/${accountId}/${modal}`, { reason });
          }}
        />
      ) : null}
      {temp ? <TemporaryPassword result={temp} onClose={() => setTemp(undefined)} /> : null}
    </section>
  );
}

export function RolesConfigurationWorkspace({
  api,
  onNavigate,
}: {
  api: ApiClient;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<AdministrationPage<Role>>();
  const [permissions, setPermissions] = useState<readonly Permission[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [editing, setEditing] = useState<Role | "new">();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        status,
      });
      if (search.trim()) params.set("search", search.trim());
      const [r, p] = await Promise.all([
        api.get<AdministrationPage<Role>>(`roles?${params}`),
        api.get<readonly Permission[]>("roles/permissions"),
      ]);
      setData(r);
      setPermissions(p);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("common.loadFailed"));
    }
  }, [api, page, pageSize, search, status, t]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="configuration-surface administration-surface">
      <PageHeader
        eyebrow={t("nav.configuration")}
        title={t("userAdmin.rolesTitle")}
        actions={
          <button className="button button-primary" onClick={() => setEditing("new")}>
            <Plus size={17} />
            {t("userAdmin.createRole")}
          </button>
        }
      />
      <div className="admin-filter-bar">
        <label className="admin-search">
          <Search size={17} />
          <input
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder={t("userAdmin.searchRoles")}
            value={search}
          />
        </label>
        <select
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          value={status}
        >
          <option value="all">{t("userAdmin.allStatuses")}</option>
          <option value="active">{t("userAdmin.active")}</option>
          <option value="disabled">{t("userAdmin.disabled")}</option>
        </select>
        <button className="icon-button" onClick={() => void load()} title={t("common.refresh")}>
          <RefreshCw size={18} />
        </button>
      </div>
      {error ? <div className="alert alert-error">{error}</div> : null}
      <div className="table-frame">
        <table className="data-table admin-data-table">
          <thead>
            <tr>
              <th>{t("userAdmin.roleName")}</th>
              <th>{t("userAdmin.description")}</th>
              <th>{t("userAdmin.permissionCount")}</th>
              <th>{t("userAdmin.assignedUsers")}</th>
              <th>{t("userAdmin.scope")}</th>
              <th>{t("common.status")}</th>
              <th>{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.length === 0 ? (
              <tr>
                <td className="empty-cell" colSpan={7}>
                  {t("userAdmin.noRoles")}
                </td>
              </tr>
            ) : (
              data?.items.map((role) => (
                <tr key={role.id}>
                  <td>
                    <strong>{role.name}</strong>
                    <small className="table-note">{role.code}</small>
                  </td>
                  <td>{role.description ?? "-"}</td>
                  <td>{role.permissionCount}</td>
                  <td>{role.assignedUserCount}</td>
                  <td>{t("userAdmin.companyScope")}</td>
                  <td>
                    <Status value={role.isActive ? "active" : "disabled"} />
                  </td>
                  <td>
                    <button
                      className="button button-quiet"
                      onClick={() => onNavigate(`/configuration/roles/${role.id}`)}
                    >
                      {t("common.view")}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pagination
        page={page}
        pageSize={pageSize}
        total={data?.total ?? 0}
        onPage={setPage}
        onPageSize={(value) => {
          setPageSize(value);
          setPage(1);
        }}
      />
      {editing ? (
        <RoleForm
          api={api}
          permissions={permissions}
          role={editing}
          onClose={() => setEditing(undefined)}
          onSaved={async () => {
            setEditing(undefined);
            await load();
          }}
        />
      ) : null}
    </section>
  );
}

export function RoleDetailsWorkspace({
  api,
  roleId,
  onBack,
  onNavigate,
}: {
  api: ApiClient;
  roleId: string;
  onBack: () => void;
  onNavigate: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [role, setRole] = useState<RoleDetails>();
  const [permissions, setPermissions] = useState<readonly Permission[]>([]);
  const [editing, setEditing] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [tab, setTab] = useState("overview");
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      const [r, p] = await Promise.all([
        api.get<RoleDetails>(`roles/${roleId}`),
        api.get<readonly Permission[]>("roles/permissions"),
      ]);
      setRole(r);
      setPermissions(p);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("common.loadFailed"));
    }
  }, [api, roleId, t]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!role)
    return (
      <section className="configuration-surface">
        <button className="button button-quiet" onClick={onBack}>
          <ChevronLeft size={17} />
          {t("common.back")}
        </button>
        <p>{error ?? t("common.loading")}</p>
      </section>
    );
  return (
    <section className="configuration-surface administration-surface">
      <button className="button button-quiet back-button" onClick={onBack}>
        <ChevronLeft size={17} />
        {t("common.back")}
      </button>
      <PageHeader
        eyebrow={t("userAdmin.roleDetails")}
        title={role.name}
        {...(role.description === null ? {} : { description: role.description })}
        actions={
          <div className="heading-actions">
            <button
              className="button button-secondary"
              disabled={role.isSystem}
              onClick={() => setEditing(true)}
            >
              {t("common.edit")}
            </button>
            <button className="button button-secondary" onClick={() => setDuplicate(true)}>
              <Copy size={17} />
              {t("userAdmin.duplicateRole")}
            </button>
          </div>
        }
      />
      {error ? <div className="alert alert-error">{error}</div> : null}
      <div className="detail-status-line">
        <Status value={role.isActive ? "active" : "disabled"} />
        <span>
          {role.permissionCount} {t("userAdmin.permissionCount")}
        </span>
        <span>
          {role.assignedUserCount} {t("userAdmin.assignedUsers")}
        </span>
      </div>
      <div className="detail-tabs">
        {["overview", "access", "assignedUsers", "history"].map((id) => (
          <button aria-selected={tab === id} key={id} onClick={() => setTab(id)}>
            {t(
              id === "access"
                ? "userAdmin.managePermissions"
                : id === "assignedUsers"
                  ? "userAdmin.assignedUsers"
                  : `userAdmin.${id}`,
            )}
          </button>
        ))}
      </div>
      {tab === "overview" ? (
        <dl className="detail-grid">
          <Detail label={t("userAdmin.roleName")} value={role.name} />
          <Detail label={t("userAdmin.description")} value={role.description} />
          <Detail label={t("userAdmin.scope")} value={t("userAdmin.companyScope")} />
          <Detail label="Code" value={role.code} />
        </dl>
      ) : tab === "access" ? (
        <PermissionReadOnly permissions={permissions} selected={role.permissions} />
      ) : tab === "assignedUsers" ? (
        <div className="table-frame">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("userAdmin.username")}</th>
                <th>{t("common.name")}</th>
                <th>{t("common.status")}</th>
              </tr>
            </thead>
            <tbody>
              {role.assignedUsers.map((user) => (
                <tr
                  key={user.accountId}
                  onClick={() => onNavigate(`/configuration/users/${user.accountId}`)}
                >
                  <td>{user.username}</td>
                  <td>{user.displayName}</td>
                  <td>
                    <Status value={user.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Audit events={role.audit} />
      )}{" "}
      {editing ? (
        <RoleForm
          api={api}
          permissions={permissions}
          role={role}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await load();
          }}
        />
      ) : null}
      {duplicate ? (
        <DuplicateRole
          api={api}
          role={role}
          onClose={() => setDuplicate(false)}
          onSaved={() => {
            setDuplicate(false);
            onBack();
          }}
        />
      ) : null}
    </section>
  );
}

function UserForm({
  api,
  roles,
  editing,
  onClose,
  onCreated,
  onSaved,
}: {
  api: ApiClient;
  roles: readonly Role[];
  editing?: UserDetails;
  onClose: () => void;
  onCreated: (result: { temporaryPassword: string; temporaryPasswordExpiresAt: string }) => void;
  onSaved?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [employees, setEmployees] = useState<readonly EmployeeOption[]>([]);
  const [username, setUsername] = useState(editing?.username ?? "");
  const [name, setName] = useState(editing?.displayName ?? "");
  const [email, setEmail] = useState(editing?.email ?? "");
  const [mobile, setMobile] = useState(editing?.mobileNumber ?? "");
  const [language, setLanguage] = useState(editing?.preferredLanguage ?? "en");
  const [status, setStatus] = useState<"active" | "disabled">(
    editing?.status === "disabled" ? "disabled" : "active",
  );
  const [selectedRoles, setSelectedRoles] = useState<readonly string[]>(
    editing?.roles.map((r) => r.id) ?? [],
  );
  const [employeeId, setEmployeeId] = useState("");
  const [force, setForce] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [availability, setAvailability] = useState({
    emailAvailable: true,
    mobileNumberAvailable: true,
    usernameAvailable: true,
  });
  useEffect(() => {
    if (editing === undefined) {
      void api.get<readonly EmployeeOption[]>("users/employees/available").then(setEmployees);
    }
  }, [api, editing]);
  useEffect(() => {
    const params = new URLSearchParams();
    if (!editing && /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(username.trim())) {
      params.set("username", username.trim());
    }
    if (email !== editing?.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      params.set("email", email.trim());
    }
    const normalizedMobile = normalizeUaeMobile(mobile);
    if (mobile !== (editing?.mobileNumber ?? "") && normalizedMobile !== undefined) {
      params.set("mobileNumber", normalizedMobile);
    }
    if (editing) params.set("excludeAccountId", editing.accountId);
    if (![...params.keys()].some((key) => key !== "excludeAccountId")) {
      setAvailability({
        emailAvailable: true,
        mobileNumberAvailable: true,
        usernameAvailable: true,
      });
      return;
    }
    const timer = window.setTimeout(() => {
      void api
        .get<{
          emailAvailable: boolean;
          mobileNumberAvailable: boolean;
          usernameAvailable: boolean;
        }>(`users/identifier-availability?${params.toString()}`)
        .then(setAvailability)
        .catch(() => undefined);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [api, editing, email, mobile, username]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      if (editing) {
        const changes: Record<string, unknown> = {
          preferredLanguage: language,
        };
        if (editing.accountKind === "company_user") changes.displayName = name;
        if (email !== editing.email) changes.email = email;
        if (mobile !== (editing.mobileNumber ?? ""))
          changes.mobileNumber = mobile ? (normalizeUaeMobile(mobile) ?? mobile) : null;
        await api.patch<void>(`users/${editing.accountId}`, changes);
        await onSaved?.();
      } else {
        const result = await api.post<{
          temporaryPassword: string;
          temporaryPasswordExpiresAt: string;
        }>("users", {
          username,
          displayName: name,
          email,
          mobileNumber: mobile ? (normalizeUaeMobile(mobile) ?? mobile) : undefined,
          preferredLanguage: language,
          roleIds: selectedRoles,
          employeeId: employeeId || undefined,
          status,
          forcePasswordChange: force,
        });
        onCreated(result);
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("userAdmin.actionFailed"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      className="modal-large"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={editing ? t("userAdmin.editUser") : t("userAdmin.createUser")}
      titleId="user-form-title"
    >
      <form className="admin-form" onSubmit={(event) => void submit(event)}>
        {error ? <div className="alert alert-error">{error}</div> : null}
        <div className="form-grid">
          {editing ? (
            <label className="field">
              <span>{t("userAdmin.accountKind")}</span>
              <input disabled value={t(`userAdmin.accountKinds.${editing.accountKind}`)} />
            </label>
          ) : null}
          <label className="field">
            <span>{t("userAdmin.username")}</span>
            <input
              autoFocus
              disabled={!!editing}
              pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,127}"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            {!availability.usernameAvailable ? (
              <small className="field-error">{t("userAdmin.usernameUnavailable")}</small>
            ) : null}
          </label>
          <label className="field">
            <span>{t("common.name")}</span>
            <input
              disabled={editing !== undefined && editing.accountKind !== "company_user"}
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            <span>{t("userAdmin.email")}</span>
            <input
              required={!editing}
              type={
                editing && email === editing.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
                  ? "text"
                  : "email"
              }
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            {!availability.emailAvailable ? (
              <small className="field-error">{t("userAdmin.emailUnavailable")}</small>
            ) : null}
          </label>
          <label className="field">
            <span>{t("userAdmin.mobile")}</span>
            <input
              autoComplete="tel"
              inputMode="tel"
              maxLength={16}
              placeholder={t("common.mobilePlaceholder")}
              required={!editing}
              value={mobile}
              onChange={(e) => setMobile(e.target.value)}
            />
            {mobile !== "" && !isUaeMobile(mobile) ? (
              <small className="field-warning">{t("userAdmin.invalidMobile")}</small>
            ) : null}
            {!availability.mobileNumberAvailable ? (
              <small className="field-error">{t("userAdmin.mobileUnavailable")}</small>
            ) : null}
          </label>
          <label className="field">
            <span>{t("userAdmin.preferredLanguage")}</span>
            <select value={language} onChange={(e) => setLanguage(e.target.value as "en" | "ar")}>
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </select>
          </label>
          {!editing ? (
            <label className="field">
              <span>{t("userAdmin.linkEmployee")}</span>
              <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                <option value="">{t("userAdmin.noEmployee")}</option>
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.code} - {employee.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        {!editing ? (
          <>
            <fieldset className="admin-fieldset">
              <legend>{t("userAdmin.selectRoles")}</legend>
              <div className="selection-list horizontal">
                {roles
                  .filter((r) => r.isActive)
                  .map((role) => (
                    <label key={role.id}>
                      <input
                        checked={selectedRoles.includes(role.id)}
                        onChange={(e) =>
                          setSelectedRoles(
                            e.target.checked
                              ? [...selectedRoles, role.id]
                              : selectedRoles.filter((id) => id !== role.id),
                          )
                        }
                        type="checkbox"
                      />
                      <span>{role.name}</span>
                    </label>
                  ))}
              </div>
            </fieldset>
            <div className="form-grid">
              <label className="field">
                <span>{t("userAdmin.accountStatus")}</span>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as "active" | "disabled")}
                >
                  <option value="active">{t("userAdmin.active")}</option>
                  <option value="disabled">{t("userAdmin.disabled")}</option>
                </select>
              </label>
              <label className="toggle-row">
                <input
                  checked={force}
                  disabled
                  onChange={(e) => setForce(e.target.checked)}
                  type="checkbox"
                />
                <span>{t("userAdmin.forceChange")}</span>
              </label>
            </div>
          </>
        ) : null}
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            {t("common.cancel")}
          </button>
          <button
            className="button button-primary"
            disabled={
              saving ||
              !availability.usernameAvailable ||
              !availability.emailAvailable ||
              !availability.mobileNumberAvailable ||
              (!!editing &&
                mobile !== (editing.mobileNumber ?? "") &&
                mobile !== "" &&
                !isUaeMobile(mobile)) ||
              (!editing &&
                (!isUaeMobile(mobile) || (status === "active" && selectedRoles.length === 0)))
            }
          >
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RoleForm({
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
  const [description, setDescription] = useState(role === "new" ? "" : (role.description ?? ""));
  const [selected, setSelected] = useState<readonly string[]>(
    role === "new" ? [] : role.permissions,
  );
  const [active, setActive] = useState(role === "new" ? true : role.isActive);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const groups = groupPermissions(permissions);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const body = {
        name,
        description: description || null,
        isActive: active,
        permissions: selected,
      };
      if (role === "new") await api.post("roles", body);
      else await api.patch(`roles/${role.id}`, body);
      await onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t("userAdmin.actionFailed"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      className="modal-wide"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={role === "new" ? t("userAdmin.createRole") : t("common.edit")}
      titleId="role-form-title"
    >
      <form className="admin-form" onSubmit={(event) => void submit(event)}>
        {error ? <div className="alert alert-error">{error}</div> : null}
        <div className="form-grid">
          <label className="field">
            <span>{t("userAdmin.roleName")}</span>
            <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>{t("userAdmin.description")}</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>
        <PermissionMatrix groups={groups} selected={selected} onChange={setSelected} />
        <label className="toggle-row">
          <input checked={active} onChange={(e) => setActive(e.target.checked)} type="checkbox" />
          <span>{t("userAdmin.active")}</span>
        </label>
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            {t("common.cancel")}
          </button>
          <button
            className="button button-primary"
            disabled={saving || (active && selected.length === 0)}
          >
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PermissionMatrix({
  groups,
  selected,
  onChange,
}: {
  groups: ReadonlyMap<string, readonly Permission[]>;
  selected: readonly string[];
  onChange: (value: readonly string[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="permission-matrix">
      {[...groups].map(([module, permissions]) => (
        <fieldset key={module}>
          <legend>{title(module)}</legend>
          <div className="permission-group-actions">
            <button
              onClick={() =>
                onChange([...new Set([...selected, ...permissions.map((p) => p.code)])])
              }
              type="button"
            >
              {t("userAdmin.selectModule")}
            </button>
            <button
              onClick={() =>
                onChange(selected.filter((code) => !permissions.some((p) => p.code === code)))
              }
              type="button"
            >
              {t("userAdmin.clearModule")}
            </button>
          </div>
          {permissions.map((permission) => (
            <label key={permission.code}>
              <input
                checked={selected.includes(permission.code)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
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
      ))}
    </div>
  );
}
function PermissionReadOnly({
  permissions,
  selected,
}: {
  permissions: readonly Permission[];
  selected: readonly string[];
}) {
  return (
    <div className="permission-readonly">
      {permissions
        .filter((p) => selected.includes(p.code))
        .map((p) => (
          <div key={p.code}>
            <ShieldCheck size={17} />
            <span>
              <strong>{p.code}</strong>
              <small>{p.description}</small>
            </span>
          </div>
        ))}
    </div>
  );
}
/**
 * Removing an assigned Role.
 *
 * Reuses the SAME endpoint `RoleAssignment` already uses to add roles --
 * `PUT users/:accountId/roles` -- with the target Role's id simply left out
 * of the set. That single endpoint already replaces the account's full Role
 * set inside a transaction and already enforces everything this needs:
 * Company scope, `users_roles.manage`, last-active-Company-Administrator
 * ("The last active Company administrator cannot lose access"), self-lockout,
 * and an audit trail (`company_user.role_removed`). There is no second
 * role-management system here, only a focused, one-Role-at-a-time UI on top
 * of the one that already exists.
 */
function RemoveRoleDialog({
  api,
  role,
  user,
  onClose,
  onRemoved,
}: {
  api: ApiClient;
  role: { id: string; name: string };
  user: UserDetails;
  onClose: () => void;
  onRemoved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const remove = () => {
    setRemoving(true);
    setError(undefined);
    const roleIds = user.roles.filter((r) => r.id !== role.id).map((r) => r.id);
    void api
      .put<void>(`users/${user.accountId}/roles`, { roleIds })
      .then(onRemoved)
      .catch((caught) => {
        setError(caught instanceof ApiError ? caught.message : t("userAdmin.actionFailed"));
        setRemoving(false);
      });
  };
  return (
    <Modal
      className="modal-small"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("userAdmin.removeRoleTitle")}
      titleId="remove-role-title"
    >
      {error ? <div className="alert alert-error">{error}</div> : null}
      <p>{t("userAdmin.removeRoleConfirm", { role: role.name, user: user.displayName })}</p>
      <p className="field-hint">{t("userAdmin.removeRoleWarning")}</p>
      <div className="modal-actions">
        <button className="button button-secondary" onClick={onClose} type="button">
          {t("common.cancel")}
        </button>
        <button className="button button-danger" disabled={removing} onClick={remove} type="button">
          {t("userAdmin.removeRoleAction")}
        </button>
      </div>
    </Modal>
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
  user: UserDetails;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<readonly string[]>(user.roles.map((r) => r.id));
  const [error, setError] = useState<string>();
  return (
    <Modal
      className="modal-small"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("userAdmin.selectRoles")}
      titleId="role-assignment-title"
    >
      {error ? <div className="alert alert-error">{error}</div> : null}
      <div className="selection-list">
        {roles
          .filter((r) => r.isActive)
          .map((role) => (
            <label key={role.id}>
              <input
                checked={selected.includes(role.id)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? [...selected, role.id]
                      : selected.filter((id) => id !== role.id),
                  )
                }
                type="checkbox"
              />
              <span className="role-assignment-option">
                <strong>{role.name}</strong>
                {role.description ? <small>{role.description}</small> : null}
                <small>
                  {role.permissions.length > 0 ? role.permissions.join(", ") : "No permissions"}
                </small>
              </span>
            </label>
          ))}
      </div>
      <div className="modal-actions">
        <button className="button button-secondary" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button
          className="button button-primary"
          disabled={user.status === "active" && selected.length === 0}
          onClick={() =>
            void api
              .put<void>(`users/${user.accountId}/roles`, { roleIds: selected })
              .then(onSaved)
              .catch((caught) =>
                setError(caught instanceof ApiError ? caught.message : t("userAdmin.actionFailed")),
              )
          }
        >
          {t("common.save")}
        </button>
      </div>
    </Modal>
  );
}
function ActionDialog({
  action,
  onClose,
  onConfirm,
}: {
  action: string;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const requiresReason = action !== "force" && action !== "revoke" ? true : true;
  return (
    <Modal
      className="modal-small"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t(
        `userAdmin.${action === "reset" ? "resetPassword" : action === "force" ? "forceChange" : action === "revoke" ? "revokeSessions" : action}`,
      )}
      titleId="action-title"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSaving(true);
          void onConfirm(reason).finally(() => setSaving(false));
        }}
      >
        <label className="field">
          <span>{t("userAdmin.reason")}</span>
          <textarea
            autoFocus
            minLength={3}
            onChange={(e) => setReason(e.target.value)}
            required={requiresReason}
            rows={4}
            value={reason}
          />
        </label>
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            {t("common.cancel")}
          </button>
          <button className="button button-primary" disabled={saving || reason.trim().length < 3}>
            {saving ? t("common.working") : t("common.confirm")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function TemporaryPassword({
  result,
  onClose,
}: {
  result: { temporaryPassword: string; temporaryPasswordExpiresAt: string };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Modal
      className="modal-small"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("userAdmin.temporaryPassword")}
      titleId="temporary-password-title"
    >
      <div className="temporary-password">
        <p>{t("userAdmin.temporaryPasswordNotice")}</p>
        <output>{result.temporaryPassword}</output>
        <p>
          <strong>{t("userAdmin.expiresAt")}:</strong>{" "}
          {dateTime(result.temporaryPasswordExpiresAt, "-")}
        </p>
        <button
          className="button button-secondary"
          onClick={() =>
            void navigator.clipboard.writeText(result.temporaryPassword).then(() => setCopied(true))
          }
        >
          <Copy size={17} />
          {copied ? <Check size={17} /> : null}
          {t("userAdmin.copyPassword")}
        </button>
      </div>
      <div className="modal-actions">
        <button className="button button-primary" onClick={onClose}>
          {t("common.done")}
        </button>
      </div>
    </Modal>
  );
}
function DuplicateRole({
  api,
  role,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  role: RoleDetails;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(`${role.name} Copy`);
  const [error, setError] = useState<string>();
  return (
    <Modal
      className="modal-small"
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("userAdmin.duplicateRole")}
      titleId="duplicate-role-title"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void api
            .post(`roles/${role.id}/duplicate`, { name })
            .then(onSaved)
            .catch((caught) =>
              setError(caught instanceof ApiError ? caught.message : t("userAdmin.actionFailed")),
            );
        }}
      >
        {error ? <div className="alert alert-error">{error}</div> : null}
        <label className="field">
          <span>{t("userAdmin.roleName")}</span>
          <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            {t("common.cancel")}
          </button>
          <button className="button button-primary">{t("userAdmin.duplicateRole")}</button>
        </div>
      </form>
    </Modal>
  );
}

function Overview({ user, onNavigate }: { user: UserDetails; onNavigate: (path: string) => void }) {
  const { t } = useTranslation();
  return (
    <>
      <dl className="detail-grid">
        <Detail label={t("userAdmin.username")} value={user.username} />
        <Detail
          label={t("userAdmin.accountKind")}
          value={t(`userAdmin.accountKinds.${user.accountKind}`)}
        />
        <Detail label={t("common.name")} value={user.displayName} />
        <Detail label={t("userAdmin.email")} value={user.email} />
        <Detail label={t("userAdmin.mobile")} value={user.mobileNumber} />
        <Detail label={t("userAdmin.preferredLanguage")} value={user.preferredLanguage} />
        <Detail
          label={t("userAdmin.employee")}
          value={
            user.employeeName
              ? `${user.employeeCode ?? ""} ${user.employeeName}`
              : t("userAdmin.noEmployee")
          }
        />
        <Detail label={t("userAdmin.driver")} value={user.driverCode ?? t("userAdmin.noDriver")} />
        <Detail label={t("userAdmin.createdAt")} value={dateTime(user.createdAt, "-")} />
        <Detail label={t("userAdmin.updatedAt")} value={dateTime(user.updatedAt, "-")} />
      </dl>
      <section className="detail-section">
        <h2>{t("access.linkedProfiles")}</h2>
        {user.linkedProfiles.length === 0 ? (
          <p>{t("access.noLinkedUser")}</p>
        ) : (
          <div className="table-scroll-x">
            <table>
              <thead>
                <tr>
                  <th>{t("access.columns.profile")}</th>
                  <th>{t("workforce.code")}</th>
                  <th>{t("common.name")}</th>
                  <th>{t("access.columns.status")}</th>
                  <th>{t("common.status")}</th>
                  <th>{t("access.linkCreated")}</th>
                  <th>{t("access.linkUpdated")}</th>
                  <th>{t("access.columns.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {user.linkedProfiles.map((profile) => (
                  <tr key={profile.id}>
                    <td>{t(`access.profile.${profile.profileType}`)}</td>
                    <td>
                      <bdi>{profile.code ?? "—"}</bdi>
                    </td>
                    <td>{profile.name ?? "—"}</td>
                    <td>{t(`access.status.${profile.accessStatus}`)}</td>
                    <td>{profile.businessStatus ?? "—"}</td>
                    <td>{dateTime(profile.createdAt, "—")}</td>
                    <td>{dateTime(profile.updatedAt, "—")}</td>
                    <td>
                      <button
                        type="button"
                        onClick={() =>
                          onNavigate(
                            profile.profileType === "trader"
                              ? `/configuration/traders/${encodeURIComponent(profile.code ?? profile.profileId)}`
                              : `/configuration/${profile.profileType}s/${encodeURIComponent(profile.code ?? profile.profileId)}`,
                          )
                        }
                      >
                        {t("access.openProfile")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
function Access({
  user,
  onAssign,
  onRemoveRole,
}: {
  user: UserDetails;
  onAssign: () => void;
  onRemoveRole: (role: { id: string; name: string }) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="detail-section">
      <div className="section-heading">
        <h2>{t("userAdmin.roles")}</h2>
        {user.accountKind === "company_user" ? (
          <button className="button button-secondary" onClick={onAssign}>
            {t("users.assignRoles")}
          </button>
        ) : null}
      </div>
      <div className="tag-list">
        {user.roles.map((role) => (
          <span className="tag tag-removable" key={role.id}>
            {role.name}
            {user.accountKind === "company_user" ? (
              <button
                className="tag-remove-button"
                // A User must always keep at least one active Role while
                // active (`assertRoles` in `user-administration.service.ts`
                // -- the same rule `RoleAssignment`'s own Save button already
                // respects). The backend still enforces this and the other
                // safeguards (last active Company Administrator, self-
                // lockout) regardless; this only avoids an avoidable
                // rejection for the one case knowable client-side.
                disabled={user.status === "active" && user.roles.length <= 1}
                onClick={() => onRemoveRole({ id: role.id, name: role.name })}
                title={t("userAdmin.removeRole")}
                type="button"
              >
                <X size={13} />
              </button>
            ) : null}
          </span>
        ))}
      </div>
      <h2>{t("userAdmin.managePermissions")}</h2>
      <div className="permission-readonly">
        {user.effectivePermissions.map((permission) => (
          <div key={permission.code}>
            <ShieldCheck size={17} />
            <span>
              <strong>{permission.code}</strong>
              <small>
                {permission.description} · {permission.sourceRoles.join(", ")}
              </small>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
function Activity({
  user,
  onReset,
  onForce,
}: {
  user: UserDetails;
  onReset: () => void;
  onForce: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="detail-section">
      <div className="section-heading">
        <h2>{t("userAdmin.activity")}</h2>
        <div>
          <button className="button button-secondary" onClick={onReset}>
            <KeyRound size={17} />
            {t("userAdmin.resetPassword")}
          </button>
          <button className="button button-secondary" onClick={onForce}>
            {t("userAdmin.forceChange")}
          </button>
        </div>
      </div>
      <dl className="detail-grid">
        <Detail
          label={t("userAdmin.lastLogin")}
          value={dateTime(user.lastLoginAt, t("userAdmin.legacyUnknown"))}
        />
        <Detail
          label={t("userAdmin.lastFailedLogin")}
          value={dateTime(user.lastFailedLoginAt, t("userAdmin.legacyUnknown"))}
        />
        <Detail label={t("userAdmin.failedAttempts")} value={String(user.failedLoginAttempts)} />
        <Detail label={t("userAdmin.lockoutTime")} value={dateTime(user.lockedUntil, "-")} />
        <Detail
          label={t("userAdmin.passwordChanged")}
          value={dateTime(user.passwordChangedAt, t("userAdmin.legacyUnknown"))}
        />
        <Detail
          label={t("userAdmin.passwordRequired")}
          value={user.forcePasswordChange ? t("common.confirm") : "-"}
        />
      </dl>
    </div>
  );
}
function Sessions({
  user,
  onRevoke,
  onRevokeAll,
}: {
  user: UserDetails;
  onRevoke: (id: string) => void;
  onRevokeAll: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="detail-section">
      <div className="section-heading">
        <h2>{t("userAdmin.sessions")}</h2>
        <button className="button button-danger" onClick={onRevokeAll}>
          {t("userAdmin.revokeSessions")}
        </button>
      </div>
      <div className="table-frame">
        <table className="data-table">
          <thead>
            <tr>
              <th>{t("userAdmin.sessionCreated")}</th>
              <th>{t("userAdmin.lastActivity")}</th>
              <th>{t("userAdmin.ipAddress")}</th>
              <th>{t("userAdmin.userAgent")}</th>
              <th>{t("userAdmin.expiresAt")}</th>
              <th>{t("common.status")}</th>
              <th>{t("common.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {user.sessions.map((session) => (
              <tr key={session.id}>
                <td>{dateTime(session.createdAt, "-")}</td>
                <td>{dateTime(session.lastActivity, t("userAdmin.legacyUnknown"))}</td>
                <td>{session.ipAddress ?? "-"}</td>
                <td className="session-agent">{session.userAgent ?? "-"}</td>
                <td>{dateTime(session.expiresAt, "-")}</td>
                <td>
                  {session.isCurrent
                    ? t("userAdmin.currentSession")
                    : session.revokedAt
                      ? t("userAdmin.revoke")
                      : t("userAdmin.active")}
                </td>
                <td>
                  <button
                    className="button button-quiet"
                    disabled={!!session.revokedAt}
                    onClick={() => onRevoke(session.id)}
                  >
                    {t("userAdmin.revoke")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function Audit({ events }: { events: readonly AdministrationAuditEvent[] }) {
  const { t } = useTranslation();
  return (
    <div className="audit-timeline">
      {events.length === 0 ? (
        <p>{t("userAdmin.legacyUnknown")}</p>
      ) : (
        events.map((event) => (
          <article key={event.id}>
            <span className="audit-dot" />
            <div>
              <strong>{event.eventType}</strong>
              <p>
                {event.actor ?? t("userAdmin.legacyUnknown")} · {dateTime(event.occurredAt, "-")}
              </p>
              {event.reason ? <blockquote>{event.reason}</blockquote> : null}
            </div>
          </article>
        ))
      )}
    </div>
  );
}
function Pagination({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pagination-bar">
      <span>
        {total} · {page}/{pages}
      </span>
      <label>
        {t("userAdmin.pageSize")}
        <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
          {[25, 50, 100].map((size) => (
            <option key={size}>{size}</option>
          ))}
        </select>
      </label>
      <button
        className="icon-button"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        title={t("common.previous")}
      >
        <ChevronLeft size={18} />
      </button>
      <button
        className="icon-button"
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
        title={t("common.next")}
      >
        <ChevronRight size={18} />
      </button>
    </div>
  );
}
function Status({ value }: { value: string }) {
  return <span className={`status-pill status-${value}`}>{title(value)}</span>;
}
function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value ?? "-"}</dd>
    </div>
  );
}
function groupPermissions(permissions: readonly Permission[]) {
  const groups = new Map<string, Permission[]>();
  for (const permission of permissions) {
    const module = permission.code.split(".")[0] ?? "configuration";
    groups.set(module, [...(groups.get(module) ?? []), permission]);
  }
  return groups;
}
function title(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function dateTime(value: string | null | undefined, fallback: string) {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value),
      )
    : fallback;
}
