import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Platform Administration foundation — Phase 1, Prompt 2.
 *
 * Three things, all of which the Prompt 1 audit named as prerequisites.
 *
 * ---------------------------------------------------------------------------
 * 1. THE `platform.*` PERMISSIONS
 * ---------------------------------------------------------------------------
 *
 * A Platform Administrator could already authenticate before this migration and
 * then hold an empty permission set, because no `platform.*` code had ever been
 * seeded. Every deny-by-default Platform route would have refused them.
 *
 * The namespace itself is not new and is not decorative: `role.service.ts`
 * already excludes `code like 'platform.%'` from the permission list a Company
 * Administrator can see or assign. Seeding into that namespace is therefore the
 * whole isolation mechanism — a Company role can never acquire one of these.
 *
 * Six codes, no more. A permission that nothing enforces is a control that
 * appears to exist and does not, so billing, Company reset, WhatsApp,
 * Storefront, Mobile and integrity auto-fix codes are left to the phases that
 * implement their behaviour.
 *
 * ---------------------------------------------------------------------------
 * 2. THE PLATFORM ROLE
 * ---------------------------------------------------------------------------
 *
 * `roles` has supported Platform scope since the first migration:
 * `roles_platform_code_unique` indexes `lower(code)` where `company_id is null`.
 * So no new table is needed — one system role with `company_id = null` and the
 * six codes attached.
 *
 * Existing bootstrapped Platform accounts are granted it here. Without that
 * step an environment that ran `security:bootstrap-platform` before today would
 * have an administrator who can sign in and reach nothing.
 *
 * `roles_permission_guard` and `role_permissions_nonempty_guard` are
 * `deferrable initially deferred` constraint triggers, so inserting the role
 * and its permissions in this one transaction is safe in either order.
 *
 * ---------------------------------------------------------------------------
 * 3. THE RESERVED SUBDOMAIN CONSTRAINT
 * ---------------------------------------------------------------------------
 *
 * `platform.bluelinegpt.com` serves the Platform Portal. The host resolver now
 * refuses to read a reserved label as a tenant, but a resolver check alone is
 * only half the guarantee: if a Company could still be *stored* with subdomain
 * `platform`, that Company would simply become unreachable, silently, and the
 * defect would surface as "our sign-in page stopped working".
 *
 * So the database refuses the value outright. The word list here is generated
 * from `apps/api/src/tenancy/reserved-subdomains.ts`, and
 * `reserved-subdomains.test.ts` fails if the two ever drift apart.
 *
 * The constraint is added `not valid` first and then validated, so an existing
 * deployment that somehow already holds a reserved subdomain fails loudly at
 * VALIDATE with the offending row named, rather than failing an ALTER with no
 * diagnostic.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    insert into permissions (code, description) values
      ('platform.access', 'Sign in to the Platform Administration Portal'),
      ('platform.companies.read', 'View Companies on the Platform'),
      ('platform.companies.manage', 'Create and manage Companies on the Platform'),
      ('platform.users.read', 'View the users of a Company from the Platform'),
      ('platform.users.manage', 'Manage the users of a Company from the Platform'),
      ('platform.audit.read', 'View Platform and Company audit history')
    on conflict (code) do nothing;

    insert into roles (company_id, code, name, description, is_system, is_active)
    select null, 'platform_super_admin', 'Platform Super Administrator',
           'Full access to the Platform Administration Portal', true, true
     where not exists (
       select 1 from roles where company_id is null and lower(code) = 'platform_super_admin'
     );

    insert into role_permissions (role_id, permission_code)
    select r.id, p.code
      from roles r
      cross join (values
        ('platform.access'),
        ('platform.companies.read'),
        ('platform.companies.manage'),
        ('platform.users.read'),
        ('platform.users.manage'),
        ('platform.audit.read')
      ) as p(code)
     where r.company_id is null and lower(r.code) = 'platform_super_admin'
    on conflict (role_id, permission_code) do nothing;

    insert into account_roles (account_id, role_id, company_id)
    select a.id, r.id, null
      from accounts a
      cross join roles r
     where a.account_kind = 'platform_administrator'
       and a.company_id is null
       and r.company_id is null
       and lower(r.code) = 'platform_super_admin'
    on conflict (account_id, role_id) do nothing;

    alter table companies
      add constraint companies_subdomain_not_reserved check (
        lower(btrim(subdomain)) not in (
          'admin','api','app','assets','auth','cdn','dashboard','internal','mail',
          'platform','static','status','store','support','www'
        )
      ) not valid;
    alter table companies validate constraint companies_subdomain_not_reserved;
  `.execute(database);
}

/**
 * Roles cannot be deleted — `reject_administration_delete` raises on every
 * DELETE against `roles`. The role is therefore deactivated and stripped, in an
 * order the constraint triggers accept: assignments go first, then the role is
 * marked inactive (so `validate_active_role_permissions` no longer requires it
 * to hold permissions), then the permissions themselves.
 */
export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table companies drop constraint if exists companies_subdomain_not_reserved;

    delete from account_roles
     where role_id in (
       select id from roles where company_id is null and lower(code) = 'platform_super_admin'
     );

    update roles set is_active = false, updated_at = now(), version = version + 1
     where company_id is null and lower(code) = 'platform_super_admin';

    delete from role_permissions
     where permission_code like 'platform.%';

    delete from permissions where code like 'platform.%';
  `.execute(database);
}
