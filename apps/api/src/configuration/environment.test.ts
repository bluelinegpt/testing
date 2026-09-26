import { configuration, validateEnvironment } from "./environment.js";

describe("environment configuration", () => {
  const originalEnvironment = process.env;

  beforeEach(() => {
    process.env = {
      DATABASE_URL: "postgresql://user:password@localhost:5432/blueline_test",
      NODE_ENV: "test",
    };
  });

  afterEach(() => {
    process.env = originalEnvironment;
  });

  it("loads safe defaults and the mandatory database URL", () => {
    const result = configuration();
    expect(result.app.port).toBe(3000);
    expect(result.app.requestBodyLimitMb).toBe(10);
    expect(result.auth.lockoutMinutes).toBe(15);
    expect(result.auth.sessionTtlMinutes).toBe(720);
    expect(result.database.connectionTimeoutMs).toBe(5000);
    expect(result.database.queryTimeoutMs).toBe(10000);
    expect(result.database.url).toContain("blueline_test");
    expect(result.companyDeletion.timeoutMs).toBe(300_000);
    expect(result.companyDeletion.backupRoot).toContain("company-deletion");
  });

  it("rejects missing database configuration", () => {
    delete process.env.DATABASE_URL;
    expect(() => configuration()).toThrow("DATABASE_URL is required");
  });

  it("rejects request limits above the approved maximum", () => {
    expect(() =>
      validateEnvironment({
        DATABASE_URL: process.env.DATABASE_URL,
        REQUEST_BODY_LIMIT_MB: "11",
      }),
    ).toThrow("REQUEST_BODY_LIMIT_MB");
  });

  it("rejects an invalid database pool range", () => {
    expect(() =>
      validateEnvironment({
        DATABASE_POOL_MAX: "2",
        DATABASE_POOL_MIN: "3",
        DATABASE_URL: process.env.DATABASE_URL,
      }),
    ).toThrow("DATABASE_POOL_MIN");
  });

  it("rejects database timeouts outside the supported range", () => {
    expect(() =>
      validateEnvironment({
        DATABASE_CONNECTION_TIMEOUT_MS: "0",
        DATABASE_URL: process.env.DATABASE_URL,
      }),
    ).toThrow("DATABASE_CONNECTION_TIMEOUT_MS");
  });

  it("rejects an unsafe Company deletion backup timeout", () => {
    expect(() =>
      validateEnvironment({
        COMPANY_DELETION_BACKUP_TIMEOUT_MS: "9999",
        DATABASE_URL: process.env.DATABASE_URL,
      }),
    ).toThrow("COMPANY_DELETION_BACKUP_TIMEOUT_MS");
  });

  it("accepts secure production origins and PostgreSQL TLS", () => {
    const result = validateEnvironment({
      CORS_ORIGINS: "https://app.example.test",
      DATABASE_URL:
        "postgresql://blueline:managed-password@db.example.test:5432/blueline?sslmode=require",
      FILE_STORAGE_LOCAL_ROOT: "/srv/blueline/files",
      NODE_ENV: "production",
    });
    expect(result.NODE_ENV).toBe("production");
  });

  it("defaults file storage to the local provider and a resolved root in development", () => {
    const result = configuration();
    expect(result.files.provider).toBe("local");
    expect(result.files.localRoot.length).toBeGreaterThan(0);
  });

  it("treats the historical 'unconfigured' file provider as local", () => {
    process.env.FILE_STORAGE_PROVIDER = "unconfigured";
    expect(configuration().files.provider).toBe("local");
  });

  it("rejects an unknown file storage provider", () => {
    process.env.FILE_STORAGE_PROVIDER = "s3";
    expect(() => configuration()).toThrow("FILE_STORAGE_PROVIDER");
  });

  it("requires an explicit file storage root in production", () => {
    expect(() =>
      validateEnvironment({
        CORS_ORIGINS: "https://app.example.test",
        DATABASE_URL:
          "postgresql://blueline:managed-password@db.example.test:5432/blueline?sslmode=require",
        NODE_ENV: "production",
      }),
    ).toThrow("FILE_STORAGE_LOCAL_ROOT");
  });

  it("rejects insecure production origins", () => {
    expect(() =>
      validateEnvironment({
        CORS_ORIGINS: "http://app.example.test",
        DATABASE_URL:
          "postgresql://blueline:managed-password@db.example.test:5432/blueline?sslmode=require",
        NODE_ENV: "production",
      }),
    ).toThrow("HTTPS");
  });

  it("rejects a local production database", () => {
    expect(() =>
      validateEnvironment({
        CORS_ORIGINS: "https://app.example.test",
        DATABASE_URL:
          "postgresql://blueline:managed-password@localhost:5432/blueline?sslmode=require",
        NODE_ENV: "production",
      }),
    ).toThrow("local host");
  });

  it("rejects unknown log levels", () => {
    process.env.LOG_LEVEL = "verbose";
    expect(() => configuration()).toThrow("LOG_LEVEL");
  });
});
