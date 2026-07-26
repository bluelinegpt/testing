export interface WebConfiguration {
  readonly apiBaseUrl: string;
}

function validateUrl(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export const webConfiguration: WebConfiguration = {
  apiBaseUrl: validateUrl(import.meta.env.VITE_API_BASE_URL, "VITE_API_BASE_URL"),
};
