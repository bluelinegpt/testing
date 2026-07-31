import { createHash } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql, type Transaction } from "kysely";

import { PasswordHasher } from "../authentication/password-hasher.js";
import { TemporaryPasswordService } from "../authentication/temporary-password.service.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import type {
  CreateBusinessUserDto,
  LegacyBusinessLinkSyncDto,
} from "./user-business-access.dto.js";

type ProfileType = "employee" | "driver" | "trader";
type AccountKind = "company_user" | "driver" | "trader";
type DatabaseExecutor = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,200}$/;
const legacySyncMaximum = 50;
const legacyClassifications = [
  "eligible",
  "already_synchronized",
  "duplicate",
  "cross_company_conflict",
  "account_kind_conflict",
  "employee_link_conflict",
  "driver_link_conflict",
  "trader_link_conflict",
  "missing_user",
  "missing_business_record",
  "inactive_business_record",
  "disabled_user",
  "invalid_legacy_reference",
  "manual_review_required",
] as const;

const accountKindByProfile: Record<ProfileType, AccountKind> = {
  driver: "driver",
  employee: "company_user",
  trader: "trader",
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

interface LegacyCandidateRow {
  readonly accountCompanyId: string | null;
  readonly accountId: string | null;
  readonly accountKind: string | null;
  readonly accountStatus: string | null;
  readonly accountVersion: string | null;
  readonly businessActive: boolean;
  readonly businessVersion: string;
  readonly code: string;
  readonly legacyReference: string | null;
  readonly profileId: string;
  readonly profileType: ProfileType;
  readonly sourceCompanyId: string;
}

interface ClassifiedLegacyCandidate extends LegacyCandidateRow {
  readonly candidateId: string;
  readonly classification: string;
  readonly classifications: readonly string[];
  readonly companyId: string;
  readonly eligible: boolean;
  readonly existingLink: boolean;
  readonly legacySource: string;
  readonly reason: string;
  readonly requiredAction: string;
  readonly safeToSynchronize: boolean;
  readonly userId: string | null;
}

@Injectable()
export class UserBusinessAccessService {
  public constructor(
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(PasswordHasher) private readonly passwordHasher: PasswordHasher,
    @Inject(TemporaryPasswordService) private readonly temporaryPasswords: TemporaryPasswordService,
  ) {}

  public list(type: ProfileType, entityId: string) {
    const { companyId } = this.tenants.current();
    return this.transactions.execute(async (transaction) => {
      await this.assertBusinessRecord(transaction, type, entityId, false);
      const rows = await sql<Record<string, unknown>>`
        select l.id,l.entity_type as "profileType",l.entity_id as "profileId",
               l.access_status as "accessStatus",l.is_primary as "isPrimary",
               l.created_at as "linkCreatedAt",l.updated_at as "linkUpdatedAt",
               a.id as "accountId",a.account_kind as "accountKind",a.username,
               coalesce(a.email,t.email) as email,
               coalesce(a.mobile_number,t.mobile_number) as "mobileNumber",
               coalesce(cu.display_name,t.name_en,d.name_en,e.name_en,a.username) as "displayName",
               a.preferred_language as "preferredLanguage",a.status as "userStatus",
               a.locked_until as "lockedUntil",a.last_login_at as "lastLoginAt",
               a.force_password_change as "mustChangePassword",
               coalesce(array_agg(distinct r.name) filter (where r.id is not null),'{}') as roles,
               coalesce(array_agg(distinct rp.permission_code) filter (where rp.permission_code is not null),'{}') as permissions
          from user_business_links l
          join accounts a on a.id=l.account_id and a.company_id=l.company_id
          left join company_users cu on cu.account_id=a.id and cu.company_id=l.company_id
          left join traders t on l.entity_type='trader' and t.id=l.entity_id
            and t.company_id=l.company_id
          left join drivers d on l.entity_type='driver' and d.id=l.entity_id
            and d.company_id=l.company_id
          left join employees e on l.entity_type='employee' and e.id=l.entity_id
            and e.company_id=l.company_id
          left join account_roles ar on ar.account_id=a.id and ar.company_id=l.company_id
          left join roles r on r.id=ar.role_id and r.company_id=l.company_id
          left join role_permissions rp on rp.role_id=r.id
         where l.company_id=${companyId}::uuid and l.entity_type=${type}
           and l.entity_id=${entityId}::uuid
         group by l.id,a.id,cu.display_name,t.id,d.id,e.id order by l.created_at desc
      `.execute(transaction);
      return rows.rows;
    });
  }

  public eligible(type: ProfileType, entityId: string, search?: string) {
    const { companyId } = this.tenants.current();
    const expectedKind = accountKindByProfile[type];
    const term = search?.trim();
    return this.transactions.execute(async (transaction) => {
      await this.assertBusinessRecord(transaction, type, entityId, true);
      const rows = await sql<Record<string, unknown>>`
        select a.id as "accountId",a.account_kind as "accountKind",a.username,a.email,
               a.mobile_number as "mobileNumber",coalesce(cu.display_name,a.username) as "displayName",
               a.status,a.last_login_at as "lastLoginAt"
          from accounts a
          left join company_users cu on cu.account_id=a.id and cu.company_id=a.company_id
         where a.company_id=${companyId}::uuid and a.account_kind=${expectedKind}
           and a.status='active' and (a.locked_until is null or a.locked_until<=now())
           and not exists (
             select 1 from user_business_links l
              where l.company_id=a.company_id and l.account_id=a.id
                and l.entity_type=${type}
                and l.access_status in ('invited','active','suspended')
                and l.entity_id<>${entityId}::uuid
           )
           ${term ? sql`and (
             a.username ilike ${`%${term}%`} or a.email ilike ${`%${term}%`}
             or a.mobile_number ilike ${`%${term}%`} or cu.display_name ilike ${`%${term}%`}
           )` : sql``}
         order by lower(coalesce(cu.display_name,a.username)),a.id limit 100
      `.execute(transaction);
      return rows.rows;
    });
  }

  public async createTraderPortalUser(
    entityId: string,
    idempotencyKey: string | undefined,
    correlationId: string,
  ): Promise<Record<string, unknown>> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    const payload = { entityId, profileType: "trader" };
    const temporaryPassword = this.temporaryPasswords.create();
    const passwordHash = await this.passwordHasher.hash(temporaryPassword);
    try {
      return await this.transactions.execute(async (transaction) => {
        const replay = await this.reserveIdempotency<Record<string, unknown>>(
          transaction,
          "user_business_access.trader.create_portal_user",
          idempotencyKey,
          payload,
        );
        if (replay !== undefined) return replay;

        await this.lockCompany(transaction, companyId);
        await this.assertBusinessRecord(transaction, "trader", entityId, true);
        const existingLink = await sql<{ id: string }>`
          select id from user_business_links
           where company_id=${companyId}::uuid and entity_type='trader'
             and entity_id=${entityId}::uuid
             and access_status in ('invited','active','suspended')
           order by created_at limit 1 for update
        `.execute(transaction);
        if (existingLink.rows[0] !== undefined) {
          throw new ApplicationException(
            "trader_portal_user_exists",
            "This Trader already has a Portal User",
            HttpStatus.CONFLICT,
          );
        }

        const traderResult = await sql<{
          accountId: string | null;
          code: string;
          email: string | null;
          mobileNumber: string;
          name: string;
        }>`
          select account_id as "accountId",code,name_en as name,email,
                 mobile_number as "mobileNumber"
            from traders
           where id=${entityId}::uuid and company_id=${companyId}::uuid
           for update
        `.execute(transaction);
        const trader = traderResult.rows[0]!;
        let accountId = trader.accountId;
        let username: string;

        if (accountId === null) {
          username = `trader.${trader.code.toLowerCase()}`;
          const account = await sql<{ id: string }>`
            insert into accounts(
              company_id,account_kind,username,email,mobile_number,password_hash,status,
              preferred_language,force_password_change,temporary_password_expires_at
            ) values(
              ${companyId}::uuid,'trader',${username},${trader.email},
              ${trader.mobileNumber},${passwordHash},'active',
              'en',true,now()+interval '24 hours'
            ) returning id
          `.execute(transaction);
          accountId = account.rows[0]!.id;
          await sql`
            update traders
               set account_id=${accountId}::uuid,updated_at=now(),version=version+1
             where id=${entityId}::uuid and company_id=${companyId}::uuid
          `.execute(transaction);
        } else {
          const account = await sql<{ username: string }>`
            select username from accounts
             where id=${accountId}::uuid and company_id=${companyId}::uuid
               and account_kind='trader'
             for update
          `.execute(transaction);
          if (account.rows[0] === undefined) {
            throw new ApplicationException(
              "trader_account_kind_required",
              "The existing Trader account is invalid for Portal access",
              HttpStatus.CONFLICT,
            );
          }
          username = account.rows[0].username;
          await sql`
            update accounts
               set email=${trader.email},mobile_number=${trader.mobileNumber},
                   password_hash=${passwordHash},status='active',force_password_change=true,
                   temporary_password_expires_at=now()+interval '24 hours',
                   password_changed_at=null,failed_login_attempts=0,locked_until=null,
                   updated_at=now(),version=version+1
             where id=${accountId}::uuid and company_id=${companyId}::uuid
          `.execute(transaction);
        }

        const link = await this.insertLink(
          transaction,
          "trader",
          entityId,
          accountId,
          actorId,
        );
        await sql`
          update account_sessions set revoked_at=coalesce(revoked_at,now())
           where account_id=${accountId}::uuid and company_id=${companyId}::uuid
             and revoked_at is null
        `.execute(transaction);
        const response = {
          accountId,
          accountKind: "trader",
          displayName: trader.name,
          linkId: link.linkId,
          status: link.status,
          temporaryPassword,
          temporaryPasswordExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          username,
        };
        await this.audit(
          transaction,
          companyId,
          actorId,
          "trader.portal_user_created",
          link.linkId,
          correlationId,
          {
            accountId,
            accountKind: "trader",
            entityId,
            forcePasswordChange: true,
            username,
          },
        );
        await this.completeIdempotency(
          transaction,
          "user_business_access.trader.create_portal_user",
          idempotencyKey!,
          accountId,
          "account",
          response,
        );
        return response;
      });
    } catch (error) {
      await this.auditRejected(
        "trader.portal_user_creation_blocked",
        correlationId,
        payload,
        error,
      );
      throw error;
    }
  }

  public async link(
    type: ProfileType,
    entityId: string,
    accountId: string,
    correlationId: string,
    idempotencyKey?: string,
  ) {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    const payload = { accountId, entityId, profileType: type };
    try {
      return await this.transactions.execute(async (transaction) => {
        const reservation = await this.reserveIdempotency<{ linkId: string; status: string; created: boolean }>(
        transaction,
        `user_business_access.${type}.link`,
        idempotencyKey,
        payload,
      );
        if (reservation !== undefined) {
          await this.audit(transaction,companyId,actorId,"user_profile.idempotent_replay",
            reservation.linkId,correlationId,{ operation: `${type}.link` });
          return reservation;
        }
        await this.assertBusinessRecord(transaction, type, entityId, true);
        await this.assertAccountEligible(transaction, type, accountId);
        const result = await this.insertLink(transaction, type, entityId, accountId, actorId);
        if (result.created) {
          await this.audit(transaction, companyId, actorId, "user_profile.linked", result.linkId, correlationId, {
            accountId,
            accountKind: accountKindByProfile[type],
            entityId,
            profileType: type,
          });
        }
        await this.completeIdempotency(
          transaction,
          `user_business_access.${type}.link`,
          idempotencyKey!,
          result.linkId,
          "user_business_link",
          result,
        );
        return result;
      });
    } catch (error) {
      await this.auditRejected("user_profile.link_blocked",correlationId,payload,error);
      throw error;
    }
  }

  public async createAndLink(
    type: ProfileType,
    entityId: string,
    input: CreateBusinessUserDto,
    idempotencyKey: string | undefined,
    correlationId: string,
  ) {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    const expectedKind = accountKindByProfile[type];
    const roleIds = [...new Set(input.roleIds ?? [])].sort();
    if (type === "employee" && roleIds.length === 0) {
      const error = new ApplicationException(
        "employee_user_role_required",
        "An Employee User must have at least one Company role",
        HttpStatus.BAD_REQUEST,
      );
      await this.auditRejected("user_profile.create_and_link_blocked",correlationId,{
        entityId,profileType:type,
      },error);
      throw error;
    }
    if (type !== "employee" && roleIds.length > 0) {
      const error = new ApplicationException(
        "portal_user_roles_not_allowed",
        "Driver and Trader portal accounts do not use Company User roles",
        HttpStatus.BAD_REQUEST,
      );
      await this.auditRejected("user_profile.create_and_link_blocked",correlationId,{
        entityId,profileType:type,
      },error);
      throw error;
    }
    const payload = {
      displayName: input.displayName.trim(),
      email: input.email?.trim().toLowerCase() ?? null,
      entityId,
      mobileNumber: input.mobileNumber ?? null,
      preferredLanguage: input.preferredLanguage,
      profileType: type,
      roleIds,
      username: input.username.trim(),
    };
    const temporaryPassword = this.temporaryPasswords.create();
    const passwordHash = await this.passwordHasher.hash(temporaryPassword);
    try {
      return await this.transactions.execute(async (transaction) => {
        const replay = await this.reserveIdempotency<Record<string, unknown>>(
        transaction,
        `user_business_access.${type}.create_and_link`,
        idempotencyKey,
        payload,
      );
        if (replay !== undefined) {
          await this.audit(transaction,companyId,actorId,"user_profile.idempotent_replay",
            String(replay.accountId ?? actorId),correlationId,{ operation: `${type}.create_and_link` });
          return replay;
      }
      await this.lockCompany(transaction, companyId);
      await this.assertBusinessRecord(transaction, type, entityId, true);
      // Email is optional for business-record account creation. Older browser
      // sessions may still submit an automatically populated Employee email.
      // If that optional address already identifies another account, create
      // this account without an email instead of blocking the whole workflow.
      // Employee access is created from the Employee record and signs in with
      // its generated username. Do not copy optional contact identifiers into
      // the login account: the same email or mobile may already identify an
      // administrator, Trader, or another historical account.
      const accountEmail = type === "employee"
        ? null
        : await this.availableOptionalEmail(transaction, payload.email);
      const accountMobileNumber = type === "employee"
        ? null
        : await this.availableOptionalMobileNumber(transaction, payload.mobileNumber);
      await this.assertIdentifiersAvailable(transaction, {
        ...payload,
        email: null,
        mobileNumber: null,
      });
      if (type === "employee") await this.assertRoles(transaction, roleIds);

      let accountId: string;
      try {
        const account = type === "employee"
          ? await sql<{ id: string }>`
              insert into accounts(
                company_id,account_kind,username,password_hash,status,
                preferred_language,force_password_change,temporary_password_expires_at
              ) values(
                ${companyId}::uuid,${expectedKind},${payload.username},${passwordHash},
                'active',${input.preferredLanguage},true,now()+interval '24 hours'
              ) returning id
            `.execute(transaction)
          : await sql<{ id: string }>`
              insert into accounts(
                company_id,account_kind,username,email,mobile_number,password_hash,status,
                preferred_language,force_password_change,temporary_password_expires_at
              ) values(
                ${companyId}::uuid,${expectedKind},${payload.username},${accountEmail},
                ${accountMobileNumber},${passwordHash},'active',${input.preferredLanguage},
                true,now()+interval '24 hours'
              ) returning id
            `.execute(transaction);
        accountId = account.rows[0]!.id;
      } catch (error) {
        throw this.translateDatabaseConflict(error, type);
      }

      if (type === "employee") {
        const companyUser = await sql<{ id: string }>`
          insert into company_users(
            company_id,account_id,name_en,display_name,is_active
          ) values(
            ${companyId}::uuid,${accountId}::uuid,${payload.displayName},${payload.displayName},
            true
          ) returning id
        `.execute(transaction);
        await sql`
          update employees
             set company_user_id=${companyUser.rows[0]!.id}::uuid,
                 updated_at=now(),version=version+1
           where id=${entityId}::uuid and company_id=${companyId}::uuid
        `.execute(transaction);
        for (const roleId of roleIds) {
          await sql`
            insert into account_roles(account_id,role_id,company_id,assigned_by_account_id)
            values(${accountId}::uuid,${roleId}::uuid,${companyId}::uuid,${actorId}::uuid)
          `.execute(transaction);
        }
      }

      const link = await this.insertLink(transaction, type, entityId, accountId, actorId);
      const response = {
        accountId,
        accountKind: expectedKind,
        linkId: link.linkId,
        status: link.status,
        temporaryPassword,
        temporaryPasswordExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      };
      await this.audit(transaction, companyId, actorId, "user_profile.account_created_and_linked", link.linkId, correlationId, {
        accountId,
        accountKind: expectedKind,
        entityId,
        forcePasswordChange: true,
        optionalEmailOmitted: payload.email !== null && accountEmail === null,
        optionalMobileOmitted:
          payload.mobileNumber !== null && accountMobileNumber === null,
        preferredLanguage: input.preferredLanguage,
        profileType: type,
        roleIds,
        username: payload.username,
      });
      await this.completeIdempotency(
        transaction,
        `user_business_access.${type}.create_and_link`,
        idempotencyKey!,
        accountId,
        "account",
        response,
      );
        return response;
      });
    } catch (error) {
      await this.auditRejected("user_profile.create_and_link_blocked",correlationId,{
        entityId,profileType:type,username:payload.username,
      },error);
      throw error;
    }
  }

  public transition(
    linkId: string,
    status: "active" | "suspended" | "revoked",
    reason: string | undefined,
    correlationId: string,
  ) {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    return this.transactions.execute(async (transaction) => {
      const current = await sql<{
        accountId: string;
        entityId: string;
        profileType: ProfileType;
        status: string;
      }>`
        select account_id as "accountId",entity_id as "entityId",
               entity_type as "profileType",access_status as status
          from user_business_links
         where id=${linkId}::uuid and company_id=${companyId}::uuid for update
      `.execute(transaction);
      const link = current.rows[0];
      if (link === undefined) throw new ApplicationException(
        "user_profile_link_not_found",
        "The profile link was not found",
        HttpStatus.NOT_FOUND,
      );
      if (link.status === status) return { linkId, status };
      if (link.status === "revoked") throw new ApplicationException(
        "user_profile_access_revoked",
        "Revoked access cannot be restored",
        HttpStatus.CONFLICT,
      );
      if (status === "active") {
        await this.assertBusinessRecord(transaction, link.profileType, link.entityId, true);
        await this.assertAccountEligible(transaction, link.profileType, link.accountId);
      }
      await sql`
        update user_business_links set access_status=${status},
          suspended_by_account_id=case when ${status}='suspended' then ${actorId}::uuid else null end,
          suspended_at=case when ${status}='suspended' then now() else null end,
          suspension_reason=case when ${status}='suspended' then ${reason ?? null} else null end,
          revoked_by_account_id=case when ${status}='revoked' then ${actorId}::uuid else revoked_by_account_id end,
          revoked_at=case when ${status}='revoked' then now() else revoked_at end,
          revocation_reason=case when ${status}='revoked' then ${reason ?? null} else revocation_reason end,
          updated_by_account_id=${actorId}::uuid,updated_at=now(),version=version+1
        where id=${linkId}::uuid and company_id=${companyId}::uuid
      `.execute(transaction);
      if (status !== "active") await sql`
        update account_sessions set revoked_at=coalesce(revoked_at,now())
         where company_id=${companyId}::uuid and profile_link_id=${linkId}::uuid and revoked_at is null
      `.execute(transaction);
      await this.audit(transaction,companyId,actorId,`user_profile.${status}`,linkId,correlationId,{ reason });
      return { linkId, status };
    });
  }

  public async revokeProfileSessions(linkId: string, correlationId: string) {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    return this.transactions.execute(async (transaction) => {
      const link = await sql<{ id: string }>`
        select id from user_business_links
         where id=${linkId}::uuid and company_id=${companyId}::uuid for update
      `.execute(transaction);
      if (!link.rows[0]) throw new ApplicationException(
        "user_profile_link_not_found",
        "The profile link was not found",
        HttpStatus.NOT_FOUND,
      );
      const changed = await sql<{ id: string }>`
        update account_sessions set revoked_at=coalesce(revoked_at,now())
         where company_id=${companyId}::uuid and profile_link_id=${linkId}::uuid
           and revoked_at is null returning id
      `.execute(transaction);
      await this.audit(transaction,companyId,actorId,"user_profile.sessions_revoked",linkId,correlationId,{
        count:changed.rows.length,
      });
      return { revokedSessions: changed.rows.length };
    });
  }

  public legacyPreview(correlationId?: string) {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    return this.transactions.execute(async (transaction) => {
      const preview = await this.buildLegacyPreview(transaction);
      for (const candidate of preview.candidates) {
        await this.audit(
          transaction,
          companyId,
          actorId,
          "user_profile.legacy_candidate_classified",
          candidate.profileId,
          correlationId ?? "legacy-preview",
          {
            candidateId: candidate.candidateId,
            classifications: candidate.classifications,
            profileType: candidate.profileType,
          },
        );
      }
      if (correlationId) await this.audit(
        transaction,
        companyId,
        actorId,
        "user_profile.legacy_previewed",
        actorId,
        correlationId,
        {
          candidateCount: preview.candidates.length,
          classificationCounts: preview.classificationCounts,
          previewIdentity: preview.previewIdentity,
        },
      );
      return preview;
    });
  }

  public async legacySync(
    input: LegacyBusinessLinkSyncDto,
    idempotencyKey: string | undefined,
    correlationId: string,
  ) {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    const selected = [...new Set(input.candidateIds)].sort();
    if (selected.length > legacySyncMaximum) {
      const error = new ApplicationException(
        "legacy_sync_batch_too_large",
        `A legacy synchronization batch cannot exceed ${legacySyncMaximum} candidates`,
        HttpStatus.BAD_REQUEST,
      );
      await this.auditRejected("user_profile.legacy_synchronization_blocked",correlationId,{
        candidateCount:selected.length,
      },error);
      throw error;
    }
    const payload = {
      candidateIds: selected,
      previewIdentity: input.previewIdentity,
      synchronizationMode: "selected_atomic_batch",
    };
    const startedAt = new Date().toISOString();
    const operationReference = createHash("sha256")
      .update(`${companyId}:legacy-sync:${idempotencyKey?.trim() ?? ""}`)
      .digest("hex");
    await this.transactions.execute((transaction) => this.audit(
      transaction,companyId,actorId,"user_profile.legacy_synchronization_started",
      actorId,correlationId,{ candidateCount:selected.length,previewIdentity:input.previewIdentity },
    ));
    try {
      return await this.transactions.execute(async (transaction) => {
        const replay = await this.reserveIdempotency<Record<string, unknown>>(
        transaction,
        "user_business_access.legacy_sync",
        idempotencyKey,
        payload,
      );
        if (replay !== undefined) {
          await this.audit(transaction,companyId,actorId,"user_profile.idempotent_replay",
            actorId,correlationId,{ operation:"legacy_sync",previewIdentity:input.previewIdentity });
          return replay;
        }

      const preview = await this.buildLegacyPreview(transaction);
      if (preview.previewIdentity !== input.previewIdentity) {
        throw new ApplicationException(
          "legacy_sync_preview_stale",
          "The legacy-link preview is stale. Refresh the preview before synchronizing.",
          HttpStatus.CONFLICT,
        );
      }
      const candidates = selected.map((candidateId) => {
        const candidate = preview.candidates.find((item) => item.candidateId === candidateId);
        if (candidate === undefined) throw new ApplicationException(
          "legacy_sync_candidate_not_found",
          "A selected legacy-link candidate is no longer available",
          HttpStatus.CONFLICT,
        );
        if (!candidate.eligible && !candidate.classifications.includes("already_synchronized")) {
          throw new ApplicationException(
            "legacy_sync_candidate_ineligible",
            "Only eligible legacy-link candidates may be synchronized",
            HttpStatus.CONFLICT,
            candidate.classifications,
          );
        }
        return candidate;
      });

      const lockOrder = candidates
        .filter((candidate) => candidate.eligible)
        .sort((left, right) =>
          `${left.profileType}:${left.profileId}:${left.accountId}`.localeCompare(
            `${right.profileType}:${right.profileId}:${right.accountId}`,
          ),
        );
      let created = 0;
      let existing = 0;
      const results: Record<string, unknown>[] = [];
      for (const candidate of lockOrder) {
        await this.assertBusinessRecord(transaction, candidate.profileType, candidate.profileId, true);
        await this.assertAccountEligible(transaction, candidate.profileType, candidate.accountId!);
        const result = await this.insertLink(
          transaction,
          candidate.profileType,
          candidate.profileId,
          candidate.accountId!,
          actorId,
        );
        if (result.created) created += 1;
        else existing += 1;
        results.push({ candidateId: candidate.candidateId, ...result });
      }
      for (const candidate of candidates.filter((item) =>
        item.classifications.includes("already_synchronized"),
      )) {
        results.push({
          candidateId: candidate.candidateId,
          created: false,
          status: "already_synchronized",
        });
      }
      existing += candidates.filter((candidate) =>
        candidate.classifications.includes("already_synchronized"),
      ).length;
      const response = {
        actorId,
        companyId,
        completedAt: new Date().toISOString(),
        conflictCount: 0,
        created,
        existing,
        failedCount: 0,
        operationReference,
        previewIdentity: input.previewIdentity,
        results,
        selectedCount: candidates.length,
        skippedCount: 0,
        startedAt,
        synchronizationMode: "selected_atomic_batch",
        total: candidates.length,
      };
      await this.audit(
        transaction,
        companyId,
        actorId,
        "user_profile.legacy_synchronized",
        actorId,
        correlationId,
        {
          candidateIds: selected,
          created,
          existing,
          previewIdentity: input.previewIdentity,
          total: candidates.length,
        },
      );
      await this.completeIdempotency(
        transaction,
        "user_business_access.legacy_sync",
        idempotencyKey!,
        actorId,
        "legacy_business_link_sync",
        response,
      );
        return response;
      });
    } catch (error) {
      await this.auditRejected("user_profile.legacy_synchronization_blocked",correlationId,{
        candidateCount:selected.length,previewIdentity:input.previewIdentity,
      },error);
      await this.auditRejected("user_profile.legacy_synchronization_rolled_back",correlationId,{
        candidateCount:selected.length,previewIdentity:input.previewIdentity,
      },error);
      throw error;
    }
  }

  private async buildLegacyPreview(database: DatabaseExecutor) {
    const { companyId } = this.tenants.current();
    const source = await sql<LegacyCandidateRow>`
      select * from (
        select 'employee'::text as "profileType",e.id as "profileId",
               e.company_id as "sourceCompanyId",e.employee_number as code,
               e.company_user_id::text as "legacyReference",cu.account_id as "accountId",
               a.company_id as "accountCompanyId",a.account_kind as "accountKind",
               a.status as "accountStatus",a.version::text as "accountVersion",
               e.is_active as "businessActive",e.version::text as "businessVersion"
          from employees e
          left join company_users cu on cu.id=e.company_user_id
          left join accounts a on a.id=cu.account_id
         where e.company_id=${companyId}::uuid and e.company_user_id is not null
        union all
        select 'driver',d.id,d.company_id,d.code,d.account_id::text,d.account_id,
               a.company_id,a.account_kind,a.status,a.version::text,
               d.account_status='active',d.version::text
          from drivers d left join accounts a on a.id=d.account_id
         where d.company_id=${companyId}::uuid and d.account_id is not null
        union all
        select 'trader',t.id,t.company_id,t.code,t.account_id::text,t.account_id,
               a.company_id,a.account_kind,a.status,a.version::text,
               t.account_status='active',t.version::text
          from traders t left join accounts a on a.id=t.account_id
         where t.company_id=${companyId}::uuid and t.account_id is not null
      ) legacy order by "profileType",code,"profileId"
    `.execute(database);
    const links = await sql<{
      accountId: string;
      entityId: string;
      profileType: ProfileType;
      status: string;
    }>`
      select account_id as "accountId",entity_id as "entityId",
             entity_type as "profileType",access_status as status
        from user_business_links
       where company_id=${companyId}::uuid
         and access_status in ('invited','active','suspended')
       order by entity_type,entity_id,account_id
    `.execute(database);

    const candidates = source.rows.map((row): ClassifiedLegacyCandidate => {
      const classifications: string[] = [];
      const expectedKind = accountKindByProfile[row.profileType];
      const exact = links.rows.some((link) =>
        link.accountId === row.accountId
        && link.entityId === row.profileId
        && link.profileType === row.profileType,
      );
      const profileConflict = row.profileType !== "trader" && links.rows.some((link) =>
        link.entityId === row.profileId
        && link.profileType === row.profileType
        && link.accountId !== row.accountId,
      );
      const accountConflict = links.rows.some((link) =>
        link.accountId === row.accountId
        && link.profileType === row.profileType
        && link.entityId !== row.profileId,
      );
      const duplicateLegacyAccount = row.accountId !== null && source.rows.some((other) =>
        other !== row
        && other.accountId === row.accountId
        && other.profileType === row.profileType
        && other.profileId !== row.profileId,
      );
      if (!row.legacyReference) classifications.push("invalid_legacy_reference");
      else if (!row.accountId) classifications.push("missing_user");
      if (!row.profileId) classifications.push("missing_business_record");
      if (row.accountCompanyId && row.accountCompanyId !== row.sourceCompanyId) {
        classifications.push("cross_company_conflict");
      }
      if (row.accountKind && row.accountKind !== expectedKind) classifications.push("account_kind_conflict");
      if (!row.businessActive) classifications.push("inactive_business_record");
      if (row.accountStatus && row.accountStatus !== "active") classifications.push("disabled_user");
      if (exact) classifications.push("already_synchronized");
      if (profileConflict) classifications.push(`${row.profileType}_link_conflict`);
      if (accountConflict) {
        classifications.push(row.profileType === "employee" ? "duplicate" : `${row.profileType}_link_conflict`);
      }
      if (duplicateLegacyAccount) classifications.push("duplicate");
      const blocking = classifications.filter((classification) =>
        classification !== "already_synchronized",
      );
      if (blocking.length === 0 && !exact) classifications.push("eligible");
      if (blocking.length > 1 || classifications.includes("invalid_legacy_reference")) {
        classifications.push("manual_review_required");
      }
      const candidateId = createHash("sha256")
        .update(`${row.profileType}:${row.profileId}:${row.accountId ?? "missing"}`)
        .digest("hex");
      return {
        ...row,
        candidateId,
        classification: classifications[0] ?? "manual_review_required",
        classifications: [...new Set(classifications)],
        companyId: row.sourceCompanyId,
        eligible: classifications.includes("eligible"),
        existingLink: exact,
        legacySource: row.profileType === "employee"
          ? "employees.company_user_id"
          : `${row.profileType}s.account_id`,
        reason: classifications.join(","),
        requiredAction: classifications.includes("eligible")
          ? "synchronize"
          : classifications.includes("already_synchronized") ? "none" : "manual_review",
        safeToSynchronize: classifications.includes("eligible"),
        userId: row.accountId,
      };
    });
    const identityBasis = candidates.map((candidate) => ({
      accountCompanyId: candidate.accountCompanyId,
      accountId: candidate.accountId,
      accountKind: candidate.accountKind,
      accountStatus: candidate.accountStatus,
      accountVersion: candidate.accountVersion,
      businessActive: candidate.businessActive,
      businessVersion: candidate.businessVersion,
      candidateId: candidate.candidateId,
      classifications: candidate.classifications,
      profileId: candidate.profileId,
      profileType: candidate.profileType,
    }));
    const classificationCounts = candidates
      .flatMap((candidate) => candidate.classifications)
      .reduce<Record<string, number>>((counts, classification) => {
        counts[classification] = (counts[classification] ?? 0) + 1;
        return counts;
      }, Object.fromEntries(legacyClassifications.map((classification) => [classification, 0])));
    return {
      candidates,
      classificationCounts,
      generatedAt: new Date().toISOString(),
      maximumBatchSize: legacySyncMaximum,
      previewIdentity: createHash("sha256").update(canonicalJson(identityBasis)).digest("hex"),
      versionBasis: "account.version + business.version + active link state",
    };
  }

  private async assertBusinessRecord(
    database: DatabaseExecutor,
    type: ProfileType,
    entityId: string,
    requireActive: boolean,
  ): Promise<void> {
    const { companyId } = this.tenants.current();
    const result = type === "employee"
      ? await sql<{ active: boolean }>`
          select is_active as active from employees
           where id=${entityId}::uuid and company_id=${companyId}::uuid for update
        `.execute(database)
      : type === "driver"
        ? await sql<{ active: boolean }>`
            select account_status='active' as active from drivers
             where id=${entityId}::uuid and company_id=${companyId}::uuid for update
          `.execute(database)
        : await sql<{ active: boolean }>`
            select account_status='active' as active from traders
             where id=${entityId}::uuid and company_id=${companyId}::uuid for update
          `.execute(database);
    if (!result.rows[0]) {
      const code = type === "employee" ? "employee_system_access_not_found"
        : type === "driver" ? "driver_system_access_not_found"
          : "trader_portal_user_not_found";
      throw new ApplicationException(code, "The business profile was not found", HttpStatus.NOT_FOUND);
    }
    if (requireActive && !result.rows[0].active) throw new ApplicationException(
      "inactive_business_record",
      "The business record must be active before User access can be changed",
      HttpStatus.CONFLICT,
    );
  }

  private async assertAccountEligible(
    database: DatabaseExecutor,
    type: ProfileType,
    accountId: string,
  ): Promise<void> {
    const { companyId } = this.tenants.current();
    const account = await sql<{ accountKind: string; status: string }>`
      select account_kind as "accountKind",status from accounts
       where id=${accountId}::uuid and company_id=${companyId}::uuid for update
    `.execute(database);
    if (!account.rows[0]) throw new ApplicationException(
      "user_profile_company_mismatch",
      "The User and business profile must belong to the same Company",
      HttpStatus.CONFLICT,
    );
    if (account.rows[0].accountKind !== accountKindByProfile[type]) throw new ApplicationException(
      type === "employee" ? "employee_account_kind_required"
        : type === "driver" ? "driver_account_kind_required" : "trader_account_kind_required",
      `A ${type} profile requires a ${accountKindByProfile[type]} account`,
      HttpStatus.CONFLICT,
    );
    if (account.rows[0].status !== "active") throw new ApplicationException(
      `user_not_eligible_for_${type}_link`,
      "The User account must be active before it can be linked",
      HttpStatus.CONFLICT,
    );
  }

  private async insertLink(
    database: DatabaseExecutor,
    type: ProfileType,
    entityId: string,
    accountId: string,
    actorId: string,
  ): Promise<{ linkId: string; status: string; created: boolean }> {
    const { companyId } = this.tenants.current();
    const existing = await sql<{ id: string; status: string }>`
      select id,access_status as status from user_business_links
       where company_id=${companyId}::uuid and account_id=${accountId}::uuid
         and entity_type=${type} and entity_id=${entityId}::uuid
         and access_status in ('invited','active','suspended') for update
    `.execute(database);
    if (existing.rows[0]) {
      return { linkId: existing.rows[0].id, status: existing.rows[0].status, created: false };
    }
    const occupied = await sql<{ accountId: string; entityId: string }>`
      select account_id as "accountId",entity_id as "entityId" from user_business_links
       where company_id=${companyId}::uuid and entity_type=${type}
         and access_status in ('invited','active','suspended')
         and (entity_id=${entityId}::uuid or account_id=${accountId}::uuid)
       order by id for update
    `.execute(database);
    if (type !== "trader" && occupied.rows.some((row) => row.entityId === entityId)) throw new ApplicationException(
      "user_profile_link_exists",
      `This ${type} already has an active User link`,
      HttpStatus.CONFLICT,
    );
    if (type !== "employee" && occupied.rows.some((row) => row.accountId === accountId)) {
      throw new ApplicationException(
        "user_profile_link_conflict",
        `This ${type} User is already linked to another ${type}`,
        HttpStatus.CONFLICT,
      );
    }
    try {
      const inserted = await sql<{ id: string }>`
        insert into user_business_links(
          company_id,account_id,entity_type,entity_id,access_status,created_by_account_id
        ) values(
          ${companyId}::uuid,${accountId}::uuid,${type},${entityId}::uuid,'active',${actorId}::uuid
        ) returning id
      `.execute(database);
      return { linkId: inserted.rows[0]!.id, status: "active", created: true };
    } catch (error) {
      throw this.translateDatabaseConflict(error, type);
    }
  }

  private async assertIdentifiersAvailable(
    database: DatabaseExecutor,
    input: { email: string | null; mobileNumber: string | null; username: string },
  ): Promise<void> {
    const { companyId } = this.tenants.current();
    const conflict = await sql<{ email: boolean; mobile: boolean; username: boolean }>`
      select exists(
        select 1 from accounts where company_id=${companyId}::uuid
          and lower(username)=lower(${input.username})
      ) as username,
      ${input.email === null ? sql`false` : sql`exists(
        select 1 from accounts where company_id=${companyId}::uuid
          and lower(email)=lower(${input.email})
      )`} as email,
      ${input.mobileNumber === null ? sql`false` : sql`exists(
        select 1 from accounts where company_id=${companyId}::uuid
          and mobile_number=${input.mobileNumber}
      )`} as mobile
    `.execute(database);
    if (conflict.rows[0]?.username) throw new ApplicationException(
      "user_username_exists",
      "This username is already in use",
      HttpStatus.CONFLICT,
    );
    if (conflict.rows[0]?.email) throw new ApplicationException(
      "user_email_exists",
      "This email address is already in use",
      HttpStatus.CONFLICT,
    );
    if (conflict.rows[0]?.mobile) throw new ApplicationException(
      "user_mobile_exists",
      "This mobile number is already in use",
      HttpStatus.CONFLICT,
    );
  }

  private async availableOptionalEmail(
    database: DatabaseExecutor,
    email: string | null,
  ): Promise<string | null> {
    if (email === null) return null;
    const { companyId } = this.tenants.current();
    const existing = await sql<{ exists: boolean }>`
      select exists(
        select 1
          from accounts
         where company_id=${companyId}::uuid
           and lower(email)=lower(${email})
        union all
        select 1
          from company_users
         where company_id=${companyId}::uuid
           and lower(email)=lower(${email})
      ) as exists
    `.execute(database);
    return existing.rows[0]?.exists ? null : email;
  }

  private async availableOptionalMobileNumber(
    database: DatabaseExecutor,
    mobileNumber: string | null,
  ): Promise<string | null> {
    if (mobileNumber === null) return null;
    const { companyId } = this.tenants.current();
    const existing = await sql<{ exists: boolean }>`
      select exists(
        select 1
          from accounts
         where company_id=${companyId}::uuid
           and mobile_number=${mobileNumber}
        union all
        select 1
          from company_users
         where company_id=${companyId}::uuid
           and mobile_number=${mobileNumber}
      ) as exists
    `.execute(database);
    return existing.rows[0]?.exists ? null : mobileNumber;
  }

  private async assertRoles(database: DatabaseExecutor, roleIds: readonly string[]): Promise<void> {
    const { companyId } = this.tenants.current();
    const roles = await sql<{ id: string }>`
      select id from roles where company_id=${companyId}::uuid and is_active
        and id=any(${roleIds}::uuid[]) for update
    `.execute(database);
    if (roles.rows.length !== roleIds.length) throw new ApplicationException(
      "company_user_role_invalid",
      "One or more selected roles are not active in this Company",
      HttpStatus.CONFLICT,
    );
  }

  private async lockCompany(database: DatabaseExecutor, companyId: string): Promise<void> {
    await sql`select id from companies where id=${companyId}::uuid for update`.execute(database);
  }

  private async reserveIdempotency<T>(
    database: DatabaseExecutor,
    operation: string,
    idempotencyKey: string | undefined,
    payload: unknown,
  ): Promise<T | undefined> {
    const { companyId } = this.tenants.current();
    const key = idempotencyKey?.trim() ?? "";
    if (!idempotencyKeyPattern.test(key)) throw new ApplicationException(
      "user_access_idempotency_key_required",
      "A valid idempotency key is required",
      HttpStatus.BAD_REQUEST,
    );
    const requestHash = createHash("sha256").update(canonicalJson(payload)).digest("hex");
    const inserted = await sql<{ id: string }>`
      insert into idempotency_records(
        company_id,operation,idempotency_key,request_hash,expires_at
      ) values(
        ${companyId}::uuid,${operation},${key},${requestHash},now()+interval '24 hours'
      ) on conflict(company_id,operation,idempotency_key) do nothing returning id
    `.execute(database);
    if (inserted.rows[0]) return undefined;
    const existing = await sql<{ requestHash: string; resourceId: string | null; response: T | null }>`
      select request_hash as "requestHash",resource_id as "resourceId",response_body as response
        from idempotency_records
       where company_id=${companyId}::uuid and operation=${operation}
         and idempotency_key=${key} for update
    `.execute(database);
    const record = existing.rows[0];
    if (!record || record.requestHash !== requestHash) throw new ApplicationException(
      "user_access_idempotency_payload_mismatch",
      "This idempotency key was already used with different User Access details",
      HttpStatus.CONFLICT,
    );
    if (!record.resourceId || record.response === null) throw new ApplicationException(
      "user_access_operation_in_progress",
      "This User Access operation is already being processed",
      HttpStatus.CONFLICT,
    );
    return record.response;
  }

  private async completeIdempotency(
    database: DatabaseExecutor,
    operation: string,
    idempotencyKey: string,
    resourceId: string,
    resourceType: string,
    response: unknown,
  ): Promise<void> {
    const { companyId } = this.tenants.current();
    await sql`
      update idempotency_records
         set response_status=200,resource_type=${resourceType},resource_id=${resourceId}::uuid,
             response_body=${JSON.stringify(response)}::jsonb,completed_at=now()
       where company_id=${companyId}::uuid and operation=${operation}
         and idempotency_key=${idempotencyKey.trim()}
    `.execute(database);
  }

  private translateDatabaseConflict(error: unknown, type: ProfileType): ApplicationException {
    const databaseError = error as { code?: string; constraint?: string };
    if (!["23505", "23503", "23514"].includes(databaseError.code ?? "")) {
      if (error instanceof ApplicationException) return error;
      throw error;
    }
    const constraint = databaseError.constraint ?? "";
    if (constraint.includes("account_kind")) return new ApplicationException(
      "user_account_kind_conflict",
      `A ${type} profile requires a ${accountKindByProfile[type]} account`,
      HttpStatus.CONFLICT,
    );
    if (constraint.includes("username")) return new ApplicationException(
      "user_username_exists",
      "This username is already in use",
      HttpStatus.CONFLICT,
    );
    if (constraint.includes("email")) return new ApplicationException(
      "user_email_exists",
      "This email address is already in use",
      HttpStatus.CONFLICT,
    );
    if (constraint.includes("mobile")) return new ApplicationException(
      "user_mobile_exists",
      "This mobile number is already in use",
      HttpStatus.CONFLICT,
    );
    if (constraint.includes("account_active")) return new ApplicationException(
      "user_profile_link_conflict",
      `This ${type} User is already linked`,
      HttpStatus.CONFLICT,
    );
    if (constraint.includes("active_unique")) return new ApplicationException(
      "user_profile_link_exists",
      `This ${type} already has an active User link`,
      HttpStatus.CONFLICT,
    );
    return new ApplicationException(
      "user_profile_link_conflict",
      "The User Access operation conflicts with current Company data",
      HttpStatus.CONFLICT,
    );
  }

  private async audit(
    transaction: DatabaseExecutor,
    companyId: string,
    actorId: string,
    action: string,
    subjectId: string,
    correlationId: string,
    after: unknown,
  ) {
    await sql`
      insert into audit_events(
        company_id,actor_account_id,action,subject_type,subject_id,after_data,
        correlation_id,actor_role,source
      ) values(
        ${companyId}::uuid,${actorId}::uuid,${action},'user_business_link',${subjectId},
        ${JSON.stringify(after)}::jsonb,${correlationId},'administrator','web'
      )
    `.execute(transaction);
  }

  private async auditRejected(
    action: string,
    correlationId: string,
    metadata: Record<string, unknown>,
    error: unknown,
  ): Promise<void> {
    const { companyId } = this.tenants.current();
    const actorId = this.identities.current().identityId;
    const failure = error instanceof ApplicationException
      ? { errorCode: error.errorCode, statusCode: error.getStatus() }
      : { errorCode: "unexpected_error", statusCode: 500 };
    try {
      await this.transactions.execute((transaction) => this.audit(
        transaction,
        companyId,
        actorId,
        action,
        actorId,
        correlationId,
        { ...metadata, ...failure },
      ));
    } catch {
      // A rejected business operation must retain its original safe error even if
      // the secondary security audit channel is temporarily unavailable.
    }
  }
}
