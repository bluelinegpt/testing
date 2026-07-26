export interface TenantContext {
  readonly companyId: string;
  readonly identityId: string;
}

export abstract class TenantContextAccessor {
  public abstract current(): TenantContext;
  public abstract run<T>(context: TenantContext, operation: () => Promise<T>): Promise<T>;
}

export const TENANT_CONTEXT_ACCESSOR = Symbol("TENANT_CONTEXT_ACCESSOR");
