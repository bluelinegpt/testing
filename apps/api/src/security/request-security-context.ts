import { AsyncLocalStorage } from "node:async_hooks";

import { Inject, Injectable } from "@nestjs/common";

import { IdentityContextAccessor, type IdentityContext } from "./identity-context.js";
import { TenantContextAccessor, type TenantContext } from "../tenancy/tenant-context.js";

export interface RequestSecurityContext {
  readonly identity: IdentityContext;
  readonly tenant: TenantContext | undefined;
}

interface MutableRequestSecurityContext {
  identity: IdentityContext | undefined;
  tenant: TenantContext | undefined;
}

@Injectable()
export class RequestSecurityContextStore {
  private readonly storage = new AsyncLocalStorage<MutableRequestSecurityContext>();

  public enter(context: RequestSecurityContext): void {
    const active = this.storage.getStore();
    if (active === undefined) {
      this.storage.enterWith({ ...context });
      return;
    }
    active.identity = context.identity;
    active.tenant = context.tenant;
  }

  public current(): RequestSecurityContext {
    const context = this.storage.getStore();
    if (context?.identity === undefined) {
      throw new Error("Authenticated request security context is unavailable");
    }
    return { identity: context.identity, tenant: context.tenant };
  }

  public run<T>(context: RequestSecurityContext, operation: () => Promise<T>): Promise<T> {
    return this.storage.run(context, operation);
  }

  public runRequest(operation: () => void): void {
    this.storage.run({ identity: undefined, tenant: undefined }, operation);
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
