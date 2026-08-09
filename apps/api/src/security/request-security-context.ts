import { AsyncLocalStorage } from "node:async_hooks";

import { Inject, Injectable } from "@nestjs/common";

import { IdentityContextAccessor, type IdentityContext } from "./identity-context.js";
import { TenantContextAccessor, type TenantContext } from "../tenancy/tenant-context.js";

/**
 * The Company a Platform request is acting against.
 *
 * This is NOT the actor's own Company. A Platform Administrator has
 * `identity.companyId === null` and always will — the account-scope constraint
 * in the database makes any other state impossible. The target Company is a
 * separate, per-request fact established by `PlatformTargetCompanyGuard` after
 * it has re-resolved the Company from the database.
 *
 * It is held here, in the AsyncLocalStorage store the request middleware
 * already opens per request, rather than in a store of its own. That matters:
 * a second `enterWith`-style store opened from inside a guard would leak into
 * whatever async work followed, and the leak would be invisible until two
 * concurrent Platform requests targeted different Companies.
 */
export interface TargetCompanyContext {
  readonly companyId: string;
  readonly code: string;
  readonly subdomain: string;
  readonly nameEn: string;
  readonly status: string;
}

export interface RequestSecurityContext {
  readonly identity: IdentityContext;
  readonly tenant: TenantContext | undefined;
  readonly targetCompany?: TargetCompanyContext | undefined;
}

interface MutableRequestSecurityContext {
  identity: IdentityContext | undefined;
  tenant: TenantContext | undefined;
  targetCompany: TargetCompanyContext | undefined;
}

@Injectable()
export class RequestSecurityContextStore {
  private readonly storage = new AsyncLocalStorage<MutableRequestSecurityContext>();

  public enter(context: RequestSecurityContext): void {
    const active = this.storage.getStore();
    if (active === undefined) {
      this.storage.enterWith({ targetCompany: undefined, ...context });
      return;
    }
    active.identity = context.identity;
    active.tenant = context.tenant;
    active.targetCompany = context.targetCompany;
  }

  /**
   * Establishes the Company a Platform request targets.
   *
   * The actor's identity is deliberately left untouched — a Platform
   * Administrator stays `companyId: null` for the whole request, so identity
   * checks keep telling the truth about who is acting. Only the tenant slot
   * moves, which is what lets an existing Company-scoped service run under an
   * explicit, server-resolved target without knowing a Platform actor exists.
   */
  public enterTargetCompany(target: TargetCompanyContext): void {
    const active = this.storage.getStore();
    if (active?.identity === undefined) {
      throw new Error("A target Company requires an authenticated request security context");
    }
    active.targetCompany = target;
    active.tenant = { companyId: target.companyId, identityId: active.identity.identityId };
  }

  public current(): RequestSecurityContext {
    const context = this.storage.getStore();
    if (context?.identity === undefined) {
      throw new Error("Authenticated request security context is unavailable");
    }
    return {
      identity: context.identity,
      tenant: context.tenant,
      targetCompany: context.targetCompany,
    };
  }

  /** The resolved target Company, or undefined when the request has none. */
  public targetCompany(): TargetCompanyContext | undefined {
    return this.storage.getStore()?.targetCompany;
  }

  public run<T>(context: RequestSecurityContext, operation: () => Promise<T>): Promise<T> {
    return this.storage.run({ targetCompany: undefined, ...context }, operation);
  }

  public runRequest(operation: () => void): void {
    this.storage.run(
      { identity: undefined, tenant: undefined, targetCompany: undefined },
      operation,
    );
  }
}

@Injectable()
export class AsyncIdentityContextAccessor extends IdentityContextAccessor {
  public constructor(
    @Inject(RequestSecurityContextStore) private readonly store: RequestSecurityContextStore,
  ) {
    super();
  }

  public current(): IdentityContext {
    return this.store.current().identity;
  }
}

@Injectable()
export class AsyncTenantContextAccessor extends TenantContextAccessor {
  public constructor(
    @Inject(RequestSecurityContextStore) private readonly store: RequestSecurityContextStore,
  ) {
    super();
  }

  public current(): TenantContext {
    const tenant = this.store.current().tenant;
    if (tenant === undefined) {
      throw new Error("This operation requires an authenticated Company context");
    }
    return tenant;
  }

  public async run<T>(context: TenantContext, operation: () => Promise<T>): Promise<T> {
    const current = this.store.current();
    return this.store.run({ ...current, tenant: context }, operation);
  }
}
