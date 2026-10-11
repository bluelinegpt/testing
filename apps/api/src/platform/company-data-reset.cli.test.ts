import { describe, expect, it } from "vitest";

import {
  CliRefusal,
  DEVELOPMENT_RESET_REQUEST,
  disposableEnvironmentRefusal,
  normalizeCliRequest,
  parseResetIntent,
} from "./company-data-reset.cli-support.js";

/** Company Data Reset, Prompt 2 -- CLI intent and environment guards (no database). */
function intent(argv: string[]) {
  const valueOf = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? (argv[index + 1] ?? "") : "";
  };
  return normalizeCliRequest(parseResetIntent(valueOf, (name) => argv.includes(name)));
}

describe("Company Data Reset CLI -- explicit intent", () => {
  it("requires an explicit preset; never infers one", () => {
    expect(() => intent([])).toThrow(CliRefusal);
    expect(() => intent(["--preset", "EVERYTHING"])).toThrow(/Unknown --preset/u);
  });

  it("defaults to KEEP_ALL_USERS; Operational / Financial never delete users", () => {
    expect(intent(["--preset", "OPERATIONAL_DATA"])).toMatchObject({ selectedDomains: ["OPERATIONAL"], userMode: "KEEP_ALL_USERS" });
    expect(intent(["--preset", "financial-data"])).toMatchObject({ selectedDomains: ["FINANCIAL"], userMode: "KEEP_ALL_USERS" });
    expect(() => intent(["--preset", "OPERATIONAL_DATA", "--user-mode", "all-eligible", "--allow-user-deletion"])).toThrow(/keeps every user/u);
  });

  it("FULL needs an explicit user mode; deleting users needs --allow-user-deletion", () => {
    expect(() => intent(["--preset", "FULL_COMPANY_DATA_KEEP_COMPANY"])).toThrow(/explicit user mode/u);
    expect(intent(["--preset", "FULL_COMPANY_DATA_KEEP_COMPANY", "--user-mode", "keep"]).userMode).toBe("KEEP_ALL_USERS");
    expect(() => intent(["--preset", "FULL_COMPANY_DATA_KEEP_COMPANY", "--user-mode", "all-eligible"])).toThrow(/--allow-user-deletion/u);
    expect(
      intent(["--preset", "FULL_COMPANY_DATA_KEEP_COMPANY", "--user-mode", "all-eligible", "--allow-user-deletion"]).userMode,
    ).toBe("DELETE_ALL_ELIGIBLE_USERS");
    expect(
      intent(["--preset", "USERS_WORKFORCE", "--user-mode", "selected", "--select", "b,a", "--allow-user-deletion"]).selectedAccountIds,
    ).toEqual(["a", "b"]);
  });

  it("db:reset:dev has one fixed intent: Operational + Financial, KEEP_ALL_USERS", () => {
    expect(DEVELOPMENT_RESET_REQUEST).toMatchObject({
      preset: "FULL_COMPANY_DATA_KEEP_COMPANY",
      selectedDomains: ["OPERATIONAL", "FINANCIAL"],
      selectedAccountIds: [],
      userMode: "KEEP_ALL_USERS",
    });
  });
});

describe("Company Data Reset CLI -- positive allow-list of disposable environments", () => {
  const local = "postgresql://postgres@127.0.0.1:5432/blueline_dev";
  it("allows development / test on a local, non-production database", () => {
    expect(disposableEnvironmentRefusal("development", local)).toBeNull();
    expect(disposableEnvironmentRefusal("test", "postgresql://postgres@localhost/blueline_test")).toBeNull();
    expect(disposableEnvironmentRefusal("development", "postgresql://postgres@/blueline_dev?host=/var/run/postgresql")).toBeNull();
  });

  it("refuses production, unknown or unset environments", () => {
    expect(disposableEnvironmentRefusal("production", local)).toMatch(/production. There is no bypass/u);
    expect(disposableEnvironmentRefusal("staging", local)).toMatch(/not an allowed disposable environment/u);
    expect(disposableEnvironmentRefusal(undefined, local)).toMatch(/unset/u);
  });

  it("refuses remote, shared or production-like databases and a missing URL", () => {
    expect(disposableEnvironmentRefusal("development", "postgresql://u@db.example.com/blueline")).toMatch(/not local/u);
    expect(disposableEnvironmentRefusal("development", "postgresql://u@127.0.0.1/blueline_prod")).toMatch(/production or shared/u);
    expect(disposableEnvironmentRefusal("development", "postgresql://u@127.0.0.1/shared_blueline")).toMatch(/production or shared/u);
    expect(disposableEnvironmentRefusal("development", undefined)).toMatch(/DATABASE_URL is not set/u);
    expect(disposableEnvironmentRefusal("development", "not a url")).toMatch(/not a valid/u);
  });
});
