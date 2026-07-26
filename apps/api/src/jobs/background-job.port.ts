export interface BackgroundJobRequest<TPayload> {
  readonly companyId: string;
  readonly idempotencyKey: string;
  readonly name: string;
  readonly payload: TPayload;
}

export abstract class BackgroundJobPort {
  public abstract enqueue<TPayload>(request: BackgroundJobRequest<TPayload>): Promise<void>;
}
