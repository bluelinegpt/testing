import type pg from "pg";

import {
  deleteResetCompanyUserAccount,
  inspectResetCompanyUserAccount,
} from "./platform-user-deletion.service.js";

export interface ResetCompanyUser {
  readonly accountId: string;
  readonly accountKind: string;
  readonly username: string;
  readonly displayName: string;
  readonly status: string;
  readonly retentionReason: string | null;
  readonly retentionReferences: readonly ResetCompanyUserReference[];
  /** Another Company still has a membership, role, profile link, or session. */
  readonly sharedIdentity: boolean;
  readonly sharedReferences: readonly string[];
}

export interface ResetCompanyUserReference {
  readonly table: string;
  readonly column: string;
  readonly rows: number;
  readonly onDelete: string;
}

export interface ResetCompanyUserRetainedIdentity {
  readonly accountId: string;
  readonly accountKind: string;
  readonly username: string;
  readonly displayName: string;
  readonly reason: "other_company_access" | "preserved_history";
  readonly references: readonly ResetCompanyUserReference[];
}

export interface ResetCompanyUserPlan {
  readonly usersToRemove: readonly ResetCompanyUser[];
  readonly adminUsersPreserved: readonly ResetCompanyUser[];
}

export interface ResetCompanyUserPreview {
  readonly selectedUsers: readonly ResetCompanyUser[];
  readonly accountsToDelete: readonly ResetCompanyUser[];
  readonly identitiesRetained: readonly ResetCompanyUserRetainedIdentity[];
  readonly adminUsersPreserved: readonly ResetCompanyUser[];
}

export async function previewResetCompanyUsers(
  client: pg.PoolClient,
  companyId: string,
  accountIds: readonly string[],
): Promise<ResetCompanyUserPreview> {
  const plan = await getResetCompanyUserPlan(client, companyId);
  const selectedIds = new Set(accountIds);
  if (selectedIds.size !== accountIds.length || selectedIds.size === 0) {
    throw new Error("Select at least one unique non-Admin Company user.");
  }
  const adminUsersPreserved = plan.adminUsersPreserved.filter((user) => selectedIds.has(user.accountId));
  if (adminUsersPreserved.length > 0) {
    throw new Error("Admin users cannot be selected for Users Only Reset.");
  }
  const selectedUsers = plan.usersToRemove.filter((user) => selectedIds.has(user.accountId));
  if (selectedUsers.length !== selectedIds.size) {
    throw new Error("One or more selected accounts are not eligible for this Company reset.");
  }

  const accountsToDelete: ResetCompanyUser[] = [];
  const identitiesRetained: ResetCompanyUserRetainedIdentity[] = [];
  for (const user of selectedUsers) {
    if (user.sharedIdentity) {
      identitiesRetained.push({
        ...user,
        reason: "other_company_access",
        references: user.sharedReferences.map((reference) => {
          const [table, column] = reference.split(".");
          return { table: table ?? reference, column: column ?? "", rows: 1, onDelete: "other-company access preserved" };
        }),
      });
      continue;
    }
    const inspection = await inspectResetCompanyUserAccount(client, companyId, user.accountId);
    if (!inspection.exists || inspection.isAdmin) {
      throw new Error(inspection.isAdmin
        ? "Admin users cannot be selected for Users Only Reset."
        : "One or more selected accounts are not eligible for this Company reset.");
    }
    if (inspection.blockingReferences.length > 0) {
      identitiesRetained.push({ ...user, reason: "preserved_history", references: inspection.blockingReferences });
    } else {
      accountsToDelete.push(user);
    }
  }
  return { selectedUsers, accountsToDelete, identitiesRetained, adminUsersPreserved };
}

export interface ResetCompanyUserCleanup {
  companyUsersRemoved: number;
  employeesUnlinked: number;
  roleAssignmentsRemoved: number;
  businessAccessLinksRemoved: number;
  sessionsRevoked: number;
  passwordResetTokensRevoked: number;
  accountsDeleted: number;
  sharedIdentitiesPreserved: number;
  historyReferencedIdentitiesPreserved: number;
  readonly retainedIdentities: ResetCompanyUserRetainedIdentity[];
}

/** Preserved tables that intentionally lose only non-Admin target-Company user rows. */
export const RESET_USER_MUTABLE_TABLES = new Set([
  "accounts",
  "account_roles",
  "account_sessions",
  "company_users",
  "password_reset_tokens",
  "user_business_links",
]);

/**
 * Company administrators are identified from their actual assigned Company
 * roles, not from an account name, email, Employee link, or display label.
 * The bootstrap `company_admin` role is included explicitly; a custom role
 * with the administrator permission is also protected. Checking each
 * assignment independently means a second, ordinary role cannot hide an
 * administrator assignment.
 */
const ADMIN_ROLE_EXISTS = `exists (
  select 1
    from account_roles assigned
    join roles assigned_role
      on assigned_role.id = assigned.role_id
     and assigned_role.company_id = assigned.company_id
    left join role_permissions assigned_permission
      on assigned_permission.role_id = assigned_role.id
   where assigned.account_id = a.id
     and assigned.company_id = $1
     and (lower(assigned_role.code) = 'company_admin'
       or assigned_permission.permission_code = 'users_roles.manage')
)`;

const SHARED_IDENTITY_EXISTS = `(
  exists (select 1 from company_users other_user
           where other_user.account_id = a.id and other_user.company_id <> $1)
  or exists (select 1 from account_roles other_role
             where other_role.account_id = a.id and other_role.company_id <> $1)
  or exists (select 1 from user_business_links other_link
             where other_link.account_id = a.id and other_link.company_id <> $1)
  or exists (select 1 from account_sessions other_session
             where other_session.account_id = a.id and other_session.company_id <> $1)
  or exists (select 1 from password_reset_tokens other_token
             where other_token.account_id = a.id and other_token.company_id <> $1)
)`;

const SHARED_IDENTITY_REFERENCES = `array_remove(array[
  case when exists (select 1 from company_users other_user
                     where other_user.account_id = a.id and other_user.company_id <> $1)
    then 'company_users.account_id' end,
  case when exists (select 1 from account_roles other_role
                     where other_role.account_id = a.id and other_role.company_id <> $1)
    then 'account_roles.account_id' end,
  case when exists (select 1 from user_business_links other_link
                     where other_link.account_id = a.id and other_link.company_id <> $1)
    then 'user_business_links.account_id' end,
  case when exists (select 1 from account_sessions other_session
                     where other_session.account_id = a.id and other_session.company_id <> $1)
    then 'account_sessions.account_id' end,
  case when exists (select 1 from password_reset_tokens other_token
                     where other_token.account_id = a.id and other_token.company_id <> $1)
    then 'password_reset_tokens.account_id' end
], null)::text[]`;

export async function getResetCompanyUserPlan(
  client: pg.PoolClient,
  companyId: string,
  lockAccounts = false,
): Promise<ResetCompanyUserPlan> {
  const users = (
    await client.query<{
      accountId: string;
      accountKind: string;
      username: string;
      displayName: string;
      status: string;
      retentionAction: string | null;
      retentionReason: string | null;
      retentionReferences: ResetCompanyUserReference[] | null;
      isAdmin: boolean;
      sharedIdentity: boolean;
      sharedReferences: string[];
    }>(
      `select a.id as "accountId", a.account_kind as "accountKind", a.username,
              coalesce(nullif(btrim(cu.display_name), ''), nullif(btrim(cu.name_en), ''),
                       nullif(btrim(retained_employee.name_en), ''), a.username)
              as "displayName",
              a.status,
              reset_evidence.action as "retentionAction",
              reset_evidence.reason as "retentionReason",
              reset_evidence.references as "retentionReferences",
              ${ADMIN_ROLE_EXISTS} as "isAdmin",
              ${SHARED_IDENTITY_EXISTS} as "sharedIdentity",
              ${SHARED_IDENTITY_REFERENCES} as "sharedReferences"
         from accounts a
         left join company_users cu on cu.account_id = a.id and cu.company_id = $1
         left join lateral (
           select e.name_en
             from employees e
            where e.company_id = a.company_id
              and (e.mobile_number = a.username or e.mobile_number = a.normalized_mobile_number)
            order by e.is_active desc, e.employee_number
            limit 1
         ) retained_employee on true
         left join lateral (
           select proof.action, proof.reason, proof.references, proof.occurred_at
             from (
               select event.action,
                      'A previous Users Only Reset removed this Company access but retained the identity for historical references.'::text as reason,
                      (
                        select retained->'references'
                          from jsonb_array_elements(
                            case
                              when jsonb_typeof(event.after_data->'retainedIdentities') = 'array'
                                then event.after_data->'retainedIdentities'
                              when jsonb_typeof(event.after_data #> '{cleanup,retainedIdentities}') = 'array'
                                then event.after_data #> '{cleanup,retainedIdentities}'
                              else '[]'::jsonb
                            end
                          ) retained
                         where retained->>'accountId' = a.id::text
                           and retained->>'reason' in ('preserved_history', 'other_company_access')
                         limit 1
                      ) as references,
                      event.occurred_at
                 from audit_events event
                where event.company_id = a.company_id
                  and event.action = 'platform.company.users_reset'
                  and exists (
                    select 1
                      from jsonb_array_elements(
                        case
                          when jsonb_typeof(event.after_data->'retainedIdentities') = 'array'
                            then event.after_data->'retainedIdentities'
                          when jsonb_typeof(event.after_data #> '{cleanup,retainedIdentities}') = 'array'
                            then event.after_data #> '{cleanup,retainedIdentities}'
                          else '[]'::jsonb
                        end
                      ) retained
                     where retained->>'accountId' = a.id::text
                       and retained->>'reason' in ('preserved_history', 'other_company_access')
                  )
               union all
               select event.action,
                      'A previous full demo-data reset disabled this Company-owned identity; it was retained for historical references.'::text,
                      (
                        select retained->'references'
                          from jsonb_array_elements(
                            case
                              when jsonb_typeof(event.after_data #> '{userCleanup,retainedIdentities}') = 'array'
                                then event.after_data #> '{userCleanup,retainedIdentities}'
                              else '[]'::jsonb
                            end
                          ) retained
                         where retained->>'accountId' = a.id::text
                         limit 1
                      ),
                      event.occurred_at
                 from audit_events event
                where event.company_id = a.company_id
                  and event.action = 'platform.company.data_reset'
                  and a.status = 'disabled'
                  and (
                    event.occurred_at = a.updated_at
                    or exists (
                      select 1
                        from jsonb_array_elements(
                          case
                            when jsonb_typeof(event.after_data #> '{userCleanup,retainedIdentities}') = 'array'
                              then event.after_data #> '{userCleanup,retainedIdentities}'
                            else '[]'::jsonb
                          end
                        ) retained
                       where retained->>'accountId' = a.id::text
                         and retained->>'reason' in ('preserved_history', 'other_company_access')
                    )
                  )
             ) proof
            order by proof.occurred_at desc
            limit 1
         ) reset_evidence on true
        where a.company_id = $1
          and a.account_kind <> 'platform_administrator'
          and (
            a.status = 'active'
            or exists (select 1 from company_users membership
                        where membership.company_id = a.company_id and membership.account_id = a.id)
            or exists (select 1 from account_roles assignment
                        where assignment.company_id = a.company_id and assignment.account_id = a.id)
            or exists (select 1 from user_business_links access_link
                        where access_link.company_id = a.company_id and access_link.account_id = a.id)
            or exists (select 1 from account_sessions session_row
                        where session_row.company_id = a.company_id and session_row.account_id = a.id)
            or exists (select 1 from password_reset_tokens reset_token
                        where reset_token.company_id = a.company_id and reset_token.account_id = a.id)
            or reset_evidence.action is not null
          )
        order by lower(coalesce(cu.display_name, cu.name_en, retained_employee.name_en, a.username)), a.id
        ${lockAccounts ? "for update of a" : ""}`,
      [companyId],
    )
  ).rows;

  const usersWithRetention = await Promise.all(users.map(async (user) => {
    if (user.retentionAction === null) return user;
    if (user.sharedIdentity) {
      const sharedReferences = user.sharedReferences.map((reference) => {
        const [table, column] = reference.split(".");
        return { table: table ?? reference, column: column ?? "", rows: 1, onDelete: "other-company access preserved" };
      });
      return {
        ...user,
        retentionReason: `Identity retained because another Company still has access (${user.sharedReferences.join(", ")}).`,
        retentionReferences: sharedReferences,
      };
    }
    // Audit evidence establishes why an otherwise detached identity belongs
    // in this Company's selective-reset list. Reinspect current FK references
    // to show today's precise retention reason, without taking locks in this
    // read-only preview transaction.
    const inspection = await inspectResetCompanyUserAccount(client, companyId, user.accountId, false);
    const references = inspection.blockingReferences;
    return {
      ...user,
      retentionReason: references.length > 0
        ? `Identity retained because preserved history still references it (${references.map((reference) => `${reference.table}.${reference.column}: ${reference.rows} row(s), ${reference.onDelete}`).join("; ")}).`
        : user.retentionReason,
      retentionReferences: references.length > 0 ? references : (user.retentionReferences ?? []),
    };
  }));

  return {
    usersToRemove: usersWithRetention
      .filter((user) => !user.isAdmin)
      .map(({ accountId, accountKind, username, displayName, status, retentionReason, retentionReferences, sharedIdentity, sharedReferences }) => ({
        accountId,
        accountKind,
        username,
        displayName,
        status,
        retentionReason,
        retentionReferences: retentionReferences ?? [],
        sharedIdentity,
        sharedReferences,
      })),
    adminUsersPreserved: usersWithRetention
      .filter((user) => user.isAdmin)
      .map(({ accountId, accountKind, username, displayName, status, retentionReason, retentionReferences, sharedIdentity, sharedReferences }) => ({
        accountId,
        accountKind,
        username,
        displayName,
        status,
        retentionReason,
        retentionReferences: retentionReferences ?? [],
        sharedIdentity,
        sharedReferences,
      })),
  };
}

export async function removeResetCompanyUsers(
  client: pg.PoolClient,
  companyId: string,
  plan: ResetCompanyUserPlan,
): Promise<ResetCompanyUserCleanup> {
  const counts: ResetCompanyUserCleanup = {
    companyUsersRemoved: 0,
    employeesUnlinked: 0,
    roleAssignmentsRemoved: 0,
    businessAccessLinksRemoved: 0,
    sessionsRevoked: 0,
    passwordResetTokensRevoked: 0,
    accountsDeleted: 0,
    sharedIdentitiesPreserved: 0,
    historyReferencedIdentitiesPreserved: 0,
    retainedIdentities: [],
  };

  const candidates: { user: ResetCompanyUser; sharedIdentity: boolean }[] = [];
  for (const user of plan.usersToRemove) {
    // Recheck before mutation. The caller holds a row lock on every candidate
    // account for the duration of the reset transaction.
    const accountState = (
      await client.query<{ isAdmin: boolean; status: string }>(
        `select ${ADMIN_ROLE_EXISTS} as "isAdmin", a.status from accounts a where a.id = $2 and a.company_id = $1 and a.account_kind <> 'platform_administrator' for update`,
        [companyId, user.accountId],
      )
    ).rows[0];
    if (accountState === undefined) continue;
    if (accountState.isAdmin) {
      throw new Error(
        `Refusing to reset — user ${user.accountId} gained an Admin role after the preview plan.`,
      );
    }

    const sharedIdentity = (
      await client.query<{ shared: boolean }>(
        `select ${SHARED_IDENTITY_EXISTS} as shared from accounts a where a.id = $2`,
        [companyId, user.accountId],
      )
    ).rows[0]?.shared;

    // Shared identities keep their other-Company session, roles, membership,
    // and account status. Only credentials/access scoped to this Company go.
    const sessions = await client.query(
      "delete from account_sessions where account_id = $2 and company_id = $1",
      [companyId, user.accountId],
    );
    const tokens = await client.query(
      "delete from password_reset_tokens where account_id = $2 and company_id = $1",
      [companyId, user.accountId],
    );
    const links = await client.query(
      "delete from user_business_links where account_id = $2 and company_id = $1",
      [companyId, user.accountId],
    );

    // Employee profiles are retained by Users Only Reset. Detach only the
    // selected login relationship before deleting its Company User membership
    // so the Employee can be linked to a freshly credentialed account later.
    // Employee compensation, salary, and payroll data are not changed.
    const employees = await client.query(
      "update employees set company_user_id = null, updated_at = now(), version = version + 1 " +
        "where company_id = $1 and company_user_id in " +
        "(select id from company_users where company_id = $1 and account_id = $2)",
      [companyId, user.accountId],
    );

    if (sharedIdentity !== true && accountState.status !== "disabled") {
      // Satisfy the deferred active-user/role invariant before removing the
      // target Company assignments. A shared identity's account status is
      // preserved so this reset cannot disable access for another Company.
      await client.query(
        "update accounts set status = 'disabled', deactivated_at = coalesce(deactivated_at, now()), " +
          "updated_at = now(), version = version + 1 where id = $1 and company_id = $2 " +
          "and account_kind <> 'platform_administrator'",
        [user.accountId, companyId],
      );
    }

    const assignments = await client.query(
      "delete from account_roles where account_id = $2 and company_id = $1",
      [companyId, user.accountId],
    );
    const memberships = await client.query(
      "delete from company_users where account_id = $2 and company_id = $1",
      [companyId, user.accountId],
    );

    counts.companyUsersRemoved += memberships.rowCount ?? 0;
    counts.employeesUnlinked += employees.rowCount ?? 0;
    counts.roleAssignmentsRemoved += assignments.rowCount ?? 0;
    counts.businessAccessLinksRemoved += links.rowCount ?? 0;
    counts.sessionsRevoked += sessions.rowCount ?? 0;
    counts.passwordResetTokensRevoked += tokens.rowCount ?? 0;
    candidates.push({ user, sharedIdentity: sharedIdentity === true });
  }

  // Delete account identities only after every target-company membership and
  // role row has been removed. This prevents an assignment's assigned_by FK
  // from making deletion order-dependent when one user granted another's role.
  for (const { user, sharedIdentity } of candidates) {
    if (sharedIdentity) {
      counts.sharedIdentitiesPreserved += 1;
      counts.retainedIdentities.push({
        accountId: user.accountId,
        accountKind: user.accountKind,
        username: user.username,
        displayName: user.displayName,
        reason: "other_company_access",
        references: user.sharedReferences.map((reference) => {
          const [table, column] = reference.split(".");
          return {
            table: table ?? reference,
            column: column ?? "",
            rows: 1,
            onDelete: "other-company access preserved",
          };
        }),
      });
      continue;
    }
    const deletion = await deleteResetCompanyUserAccount(client, companyId, user.accountId);
    if (deletion.deleted) {
      counts.accountsDeleted += 1;
    } else {
      counts.historyReferencedIdentitiesPreserved += 1;
      counts.retainedIdentities.push({
        accountId: user.accountId,
        accountKind: user.accountKind,
        username: user.username,
        displayName: user.displayName,
        reason: "preserved_history",
        references: deletion.blockingReferences,
      });
    }
  }

  return counts;
}
