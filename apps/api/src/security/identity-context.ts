export type IdentityKind = "platform_administrator" | "company_user" | "trader" | "driver" | "customer";

export interface IdentityContext {
  readonly identityId: string;
  readonly kind: IdentityKind;
  readonly permissions: ReadonlySet<string>;
  readonly companyId: string | null;
  readonly sessionId: string;
  readonly forcePasswordChange: boolean;
  readonly profileLinkId?: string;
  readonly profileType?: "employee" | "driver" | "trader";
  readonly profileId?: string;
  readonly companyName?: string;
  readonly companyNameAr?: string;
}

export abstract class IdentityContextAccessor {
  public abstract current(): IdentityContext;
}

export const IDENTITY_CONTEXT_ACCESSOR = Symbol("IDENTITY_CONTEXT_ACCESSOR");
