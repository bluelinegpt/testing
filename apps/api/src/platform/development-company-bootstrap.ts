import { randomUUID } from "node:crypto";

import { type Transaction, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

import { seedCompanyDefaults } from "./company-defaults.js";

export interface DevelopmentCompanyInput {
  readonly companyName: string;
  /** Already hashed. A plaintext password never reaches this function. */
  readonly passwordHash: string;
  readonly subdomain: string;
  readonly username: string;
}

export interface DevelopmentCompanyIdentifiers {
  readonly accountId: string;
  readonly companyId: string;
  readonly companyCode: string;
  readonly roleId: string;
}

/**
 * Creates the development Company, its administrator and the mandatory defaults.
 *
 * Extracted from the bootstrap script so the behaviour can be tested inside a
 * rolled-back transaction without creating a real Company or handling a
 * plaintext password.
 *
 * Not insert-idempotent by design: a second run for the same subdomain fails
 * safely with a clear error rather than mutating the existing Company.
 */
export async function bootstrapDevelopmentCompany(
  transaction: Transaction<DatabaseSchema>,
  input: DevelopmentCompanyInput,
): Promise<DevelopmentCompanyIdentifiers> {
  await sql`select pg_advisory_xact_lock(hashtext('blueline-development-company-bootstrap'))`.execute(
    transaction,
  );
  const existing = await sql<{ count: number }>`
    select count(*)::int as count
      from companies
     where lower(subdomain) = lower(${input.subdomain})
  `.execute(transaction);
  if ((existing.rows[0]?.count ?? 0) > 0) {
    throw new Error(`Development Company '${input.subdomain}' already exists`);
  }

  const companyId = randomUUID();
  const accountId = randomUUID();
  const roleId = randomUUID();
  const companyCode = `DEV-${companyId.slice(0, 8).toUpperCase()}`;

  await sql`
    insert into companies (id, code, subdomain, name_en, status, activated_at)
    values (
      ${companyId}::uuid, ${companyCode}, ${input.subdomain}, ${input.companyName},
      'active', now()
    )
  `.execute(transaction);
  await sql`
    insert into accounts (
      id, company_id, account_kind, username, password_hash, status, password_changed_at
    ) values (
      ${accountId}::uuid, ${companyId}::uuid, 'company_user', ${input.username},
      ${input.passwordHash}, 'active', now()
    )
  `.execute(transaction);
  // display_name is the authoritative single Name field; name_en is retained
  // only for legacy compatibility.
  await sql`
    insert into company_users (company_id, account_id, display_name, name_en)
    values (
      ${companyId}::uuid, ${accountId}::uuid,
      'Development Administrator', 'Development Administrator'
    )
  `.execute(transaction);
  await sql`
    insert into roles (id, company_id, code, name, is_system)
    values (${roleId}::uuid, ${companyId}::uuid, 'company_admin', 'Company Administrator', true)
  `.execute(transaction);
  await sql`
    insert into role_permissions (role_id, permission_code)
    values (${roleId}::uuid, 'users_roles.manage')
  `.execute(transaction);
  await sql`
    insert into account_roles (account_id, role_id, company_id)
    values (${accountId}::uuid, ${roleId}::uuid, ${companyId}::uuid)
  `.execute(transaction);
  await seedCompanyDefaults(transaction, companyId);
  await sql`
    insert into audit_events (
      company_id, actor_account_id, action, subject_type, subject_id,
      after_data, correlation_id
    ) values (
      ${companyId}::uuid, ${accountId}::uuid, 'development_company.bootstrap', 'company',
      ${companyId}::text,
      jsonb_build_object('subdomain', ${input.subdomain}::text, 'status', 'active'),
      ${`development-bootstrap:${companyId}`}
    )
  `.execute(transaction);

  return { accountId, companyCode, companyId, roleId };
}
