export interface ApiErrorResponse {
  error: {
    code: string;
    correlationId: string;
    details?: readonly string[];
    diagnostics?: Readonly<Record<string, boolean | number | string | null>>;
    message: string;
  };
}
