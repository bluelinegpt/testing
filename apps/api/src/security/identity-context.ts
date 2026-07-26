export type IdentityKind = "platform_administrator" | "company_user" | "trader" | "driver";

export interface IdentityContext {
  readonly identityId: string;
  readonly kind: IdentityKind;
  readonly permissions: ReadonlySet<string>;
  readonly companyId: string | null;
  readonly sessionId: string;
  readonly forcePasswordChange: boolean;
}

export abstract class IdentityContextAccessor {
  public abstract current(): IdentityContext;
}

export const IDENTITY_CONTEXT_ACCESSOR = Symbol("IDENTITY_CONTEXT_ACCESSOR");
