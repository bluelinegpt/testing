import { isAbsolute, resolve } from "node:path";

const environments = ["development", "test", "production"] as const;
type ApplicationEnvironment = (typeof environments)[number];
const fileStorageProviders = ["local", "r2"] as const;
type FileStorageProvider = (typeof fileStorageProviders)[number];
const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export interface AppConfiguration {
  companyDeletion: {
    backupRoot: string;
    timeoutMs: number;
  };
  app: {
    corsOrigins: string[];
    environment: ApplicationEnvironment;
    logLevel: string;
    port: number;
    requestBodyLimitMb: number;
  };
  auth: {
    lockoutMinutes: number;
    sessionTtlMinutes: number;
  };
  database: {
    connectionTimeoutMs: number;
    poolMax: number;
    poolMin: number;
    queryTimeoutMs: number;
    url: string;
  };
  files: {
    /** Storage provider for private file objects: "local" or "r2". */
    provider: FileStorageProvider;
    /**
     * Absolute directory that holds privately-stored file bytes. It must live
     * OUTSIDE any web root — nothing serves it statically; logos are streamed
     * only through an authenticated, Company-scoped endpoint. Only read when
     * provider is "local".
     */
    localRoot: string;
    /**
     * Cloudflare R2 (S3-compatible) settings. Only read when provider is
     * "r2" -- undefined otherwise, so a "local" deployment never needs these
     * set. R2's own endpoint is derived from accountId
     * (https://{accountId}.r2.cloudflarestorage.com); region is always
     * "auto", R2's own convention, not a real AWS region.
     */
    r2:
      | {
          readonly accountId: string;
          readonly accessKeyId: string;
          readonly bucketName: string;
          readonly secretAccessKey: string;
        }
      | undefined;
  };
  push: {
    /**
     * The Firebase Admin SDK service-account credential, as a JSON string
     * (never a file path — this deploys the same way the rest of the app's
     * secrets do, via an environment variable, and is never committed).
     * Absent in DEV until a real Firebase project exists: `FirebasePushProvider`
     * treats that as "not configured" and reports every send as a transient
     * failure rather than throwing at bootstrap, so the API starts and runs
     * normally without it.
     */
    firebaseServiceAccountJson: string | undefined;
  };
  whatsapp: {
    accessToken: string | undefined;
    appSecret: string | undefined;
    phoneNumberId: string | undefined;
    verifyToken: string | undefined;
    graphApiBaseUrl: string;
  };
  tenancy: {
    /**
     * Host suffix the Company app label is taken from. For example,
     * `acmeapp.tawseelhub.com` resolves to Company subdomain `acme`.
     */
    hostSuffix: string | undefined;
    /**
     * Development-only fallback Company subdomain, used when the request host
     * carries no tenant label (localhost, an IP, or a bare host). Never
     * consulted in production, so a misconfigured host cannot silently serve
     * another tenant's data.
     */
    developmentCompanySubdomain: string | undefined;
  };
}

function parseInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value ?? String(defaultValue), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseEnvironment(value: string | undefined): ApplicationEnvironment {
  const environment = value ?? "development";
  if (!environments.includes(environment as ApplicationEnvironment)) {
    throw new Error(`NODE_ENV must be one of: ${environments.join(", ")}`);
  }
  return environment as ApplicationEnvironment;
}

function requireValue(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function parseCorsOrigins(
  value: string | undefined,
  environment: ApplicationEnvironment,
): string[] {
  if (environment === "production" && (value === undefined || value.trim().length === 0)) {
    throw new Error("CORS_ORIGINS is required in production");
  }

  const origins = (value ?? "http://localhost:5174,http://localhost:5177")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  for (const origin of origins) {
    if (origin === "*") {
      throw new Error("CORS_ORIGINS must not contain a wildcard");
    }
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.pathname !== "/") {
      throw new Error("CORS_ORIGINS entries must be HTTP(S) origins without paths");
    }
    if (environment === "production" && parsed.protocol !== "https:") {
      throw new Error("CORS_ORIGINS entries must use HTTPS in production");
    }
  }
  return origins;
}

function parseDatabaseUrl(value: string | undefined, environment: ApplicationEnvironment): string {
  const databaseUrl = requireValue(value, "DATABASE_URL");
  const parsed = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("DATABASE_URL must use PostgreSQL");
  }

  if (environment === "production") {
    if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
      throw new Error("DATABASE_URL must not use a local host in production");
    }
    if (parsed.password.length === 0 || parsed.password === "change-me") {
      throw new Error("DATABASE_URL must contain managed production credentials");
    }
    if (
      !["require", "verify-ca", "verify-full"].includes(parsed.searchParams.get("sslmode") ?? "")
    ) {
      throw new Error("DATABASE_URL must require TLS in production");
    }
  }
  return databaseUrl;
}

function parseLogLevel(value: string | undefined): string {
  const level = value ?? "info";
  if (!logLevels.includes(level as (typeof logLevels)[number])) {
    throw new Error(`LOG_LEVEL must be one of: ${logLevels.join(", ")}`);
  }
  return level;
}

const subdomainPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function parseOptionalHostSuffix(value: string | undefined): string | undefined {
  const suffix = value?.trim().toLowerCase().replace(/^\.+/, "");
  if (suffix === undefined || suffix.length === 0) return undefined;
  return suffix;
}

/**
 * The development Company fallback is rejected outright in production. Allowing
 * it there would let a single environment variable override tenant resolution
 * for every request, which is precisely the cross-tenant leak the host-based
 * scheme exists to prevent.
 */
function parseDevelopmentCompanySubdomain(
  value: string | undefined,
  environment: ApplicationEnvironment,
): string | undefined {
  const subdomain = value?.trim().toLowerCase();
  if (subdomain === undefined || subdomain.length === 0) return undefined;
  if (environment === "production") {
    throw new Error("BLUELINE_DEV_COMPANY_SUBDOMAIN must not be set in production");
  }
  if (!subdomainPattern.test(subdomain)) {
    throw new Error("BLUELINE_DEV_COMPANY_SUBDOMAIN must be a valid subdomain label");
  }
  return subdomain;
}

function parseFileStorageProvider(value: string | undefined): FileStorageProvider {
  const provider = (value ?? "local").trim().toLowerCase();
  // A local adapter now exists, so the historical placeholder "unconfigured"
  // (and an empty value) resolve to the local provider rather than failing
  // startup. Any other explicit value must name a real, supported provider.
  const normalized = provider === "" || provider === "unconfigured" ? "local" : provider;
  if (!fileStorageProviders.includes(normalized as FileStorageProvider)) {
    throw new Error(`FILE_STORAGE_PROVIDER must be one of: ${fileStorageProviders.join(", ")}`);
  }
  return normalized as FileStorageProvider;
}

/** Required, all four, only when FILE_STORAGE_PROVIDER=r2 -- fails startup
 *  immediately rather than booting into a File Storage that will throw on
 *  every request. Undefined (not read) when the provider is "local". */
function parseFileStorageR2(provider: FileStorageProvider): AppConfiguration["files"]["r2"] {
  if (provider !== "r2") return undefined;
  const required = (name: string, value: string | undefined): string => {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed.length === 0) {
      throw new Error(`${name} is required when FILE_STORAGE_PROVIDER=r2`);
    }
    return trimmed;
  };
  return {
    accountId: required("R2_ACCOUNT_ID", process.env.R2_ACCOUNT_ID),
    accessKeyId: required("R2_ACCESS_KEY_ID", process.env.R2_ACCESS_KEY_ID),
    bucketName: required("R2_BUCKET_NAME", process.env.R2_BUCKET_NAME),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY", process.env.R2_SECRET_ACCESS_KEY),
  };
}

function parseFileStorageLocalRoot(
  value: string | undefined,
  environment: ApplicationEnvironment,
  // Optional and defaulted to "local": the unrelated companyDeletion.backupRoot
  // reuses this same path-resolution helper and has nothing to do with the
  // file storage provider, so it always wants the strict production-required
  // behavior below, same as before this parameter existed.
  provider: FileStorageProvider = "local",
): string {
  const raw = value?.trim();
  if (raw === undefined || raw.length === 0) {
    // Only required in production when it's actually the active provider --
    // an r2 deployment has no local disk to fall back to, and shouldn't need
    // to set an unused path just to satisfy this check.
    if (environment === "production" && provider === "local") {
      throw new Error("FILE_STORAGE_LOCAL_ROOT is required in production");
    }
    return resolve(process.cwd(), ".file-storage");
  }
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

export function configuration(): AppConfiguration {
  const environment = parseEnvironment(process.env.NODE_ENV);
  const databasePoolMax = parseInteger(
    process.env.DATABASE_POOL_MAX,
    "DATABASE_POOL_MAX",
    10,
    1,
    100,
  );
  const databasePoolMin = parseInteger(
    process.env.DATABASE_POOL_MIN,
    "DATABASE_POOL_MIN",
    0,
    0,
    20,
  );
  if (databasePoolMin > databasePoolMax) {
    throw new Error("DATABASE_POOL_MIN must not exceed DATABASE_POOL_MAX");
  }

  return {
    companyDeletion: {
      backupRoot: parseFileStorageLocalRoot(
        process.env.COMPANY_DELETION_BACKUP_ROOT ??
          resolve(process.cwd(), ".backups/company-deletion"),
        environment,
      ),
      timeoutMs: parseInteger(
        process.env.COMPANY_DELETION_BACKUP_TIMEOUT_MS,
        "COMPANY_DELETION_BACKUP_TIMEOUT_MS",
        300_000,
        10_000,
        1_800_000,
      ),
    },
    app: {
      corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS, environment),
      environment,
      logLevel: parseLogLevel(process.env.LOG_LEVEL),
      port: parseInteger(process.env.API_PORT, "API_PORT", 3000, 1, 65_535),
      requestBodyLimitMb: parseInteger(
        process.env.REQUEST_BODY_LIMIT_MB,
        "REQUEST_BODY_LIMIT_MB",
        10,
        1,
        10,
      ),
    },
    tenancy: {
      hostSuffix: parseOptionalHostSuffix(process.env.BLUELINE_TENANT_HOST_SUFFIX),
      developmentCompanySubdomain: parseDevelopmentCompanySubdomain(
        process.env.BLUELINE_DEV_COMPANY_SUBDOMAIN,
        environment,
      ),
    },
    auth: {
      lockoutMinutes: parseInteger(
        process.env.AUTH_LOCKOUT_MINUTES,
        "AUTH_LOCKOUT_MINUTES",
        15,
        1,
        1_440,
      ),
      sessionTtlMinutes: parseInteger(
        process.env.AUTH_SESSION_TTL_MINUTES,
        "AUTH_SESSION_TTL_MINUTES",
        720,
        5,
        10_080,
      ),
    },
    database: {
      connectionTimeoutMs: parseInteger(
        process.env.DATABASE_CONNECTION_TIMEOUT_MS,
        "DATABASE_CONNECTION_TIMEOUT_MS",
        5_000,
        100,
        120_000,
      ),
      poolMax: databasePoolMax,
      poolMin: databasePoolMin,
      queryTimeoutMs: parseInteger(
        process.env.DATABASE_QUERY_TIMEOUT_MS,
        "DATABASE_QUERY_TIMEOUT_MS",
        10_000,
        100,
        120_000,
      ),
      url: parseDatabaseUrl(process.env.DATABASE_URL, environment),
    },
    files: (() => {
      const provider = parseFileStorageProvider(process.env.FILE_STORAGE_PROVIDER);
      return {
        localRoot: parseFileStorageLocalRoot(
          process.env.FILE_STORAGE_LOCAL_ROOT,
          environment,
          provider,
        ),
        provider,
        r2: parseFileStorageR2(provider),
      };
    })(),
    push: {
      firebaseServiceAccountJson:
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim() === ""
          ? undefined
          : process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    },
    whatsapp: {
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN?.trim() || undefined,
      appSecret: process.env.WHATSAPP_APP_SECRET?.trim() || undefined,
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || undefined,
      verifyToken: process.env.WHATSAPP_VERIFY_TOKEN?.trim() || undefined,
      graphApiBaseUrl:
        process.env.WHATSAPP_GRAPH_API_BASE_URL?.trim() || "https://graph.facebook.com/v20.0",
    },
  };
}

export function validateEnvironment(environment: Record<string, unknown>): Record<string, unknown> {
  const previousEnvironment = process.env;
  process.env = { ...previousEnvironment, ...environment } as NodeJS.ProcessEnv;
  try {
    configuration();
    return environment;
  } finally {
    process.env = previousEnvironment;
  }
}
