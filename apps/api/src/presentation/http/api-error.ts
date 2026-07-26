export interface ApiErrorResponse {
  error: {
    code: string;
    correlationId: string;
    details?: readonly string[];
    message: string;
  };
}
