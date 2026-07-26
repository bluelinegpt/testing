export const defaultPageSize = 25;
export const maximumPageSize = 100;

export interface PageRequest {
  cursor?: string;
  limit: number;
  sort?: string;
}

export interface PageResult<T> {
  items: readonly T[];
  nextCursor?: string;
}

export function normalizePageSize(value: number | undefined): number {
  if (value === undefined) {
    return defaultPageSize;
  }
  if (!Number.isInteger(value) || value < 1 || value > maximumPageSize) {
    throw new Error(`Page size must be between 1 and ${maximumPageSize}`);
  }
  return value;
}
