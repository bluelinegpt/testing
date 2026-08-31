import "reflect-metadata";

import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";

import { UpdateTraderWhatsAppSettingsDto } from "./whatsapp.dto.js";

async function validationErrors(input: object) {
  const instance = plainToInstance(UpdateTraderWhatsAppSettingsDto, input);
  return validate(instance, { forbidNonWhitelisted: true, whitelist: true });
}

describe("UpdateTraderWhatsAppSettingsDto", () => {
  it("accepts a full valid payload", async () => {
    const errors = await validationErrors({
      destinationType: "group",
      groupNameSnapshot: "Dana vs NoorStore",
      messageLanguage: "both",
      notificationsEnabled: true,
      providerGroupId: "120363021234567890@g.us",
    });
    expect(errors).toEqual([]);
  });

  it("accepts a minimal payload (language defaults are applied downstream)", async () => {
    const errors = await validationErrors({ notificationsEnabled: false });
    expect(errors).toEqual([]);
  });

  it.each(["fr", "arabic", "EN", "", 5])(
    "rejects the invalid message language %j",
    async (messageLanguage) => {
      const errors = await validationErrors({ messageLanguage, notificationsEnabled: false });
      expect(errors.map((error) => error.property)).toContain("messageLanguage");
    },
  );

  it.each(["both", "ar", "en"])("accepts the allowed message language %j", async (language) => {
    const errors = await validationErrors({
      messageLanguage: language,
      notificationsEnabled: false,
    });
    expect(errors).toEqual([]);
  });

  it("rejects a non-boolean notificationsEnabled", async () => {
    const errors = await validationErrors({ notificationsEnabled: "yes" });
    expect(errors.map((error) => error.property)).toContain("notificationsEnabled");
  });

  it("rejects an unknown destination type — only `group` exists in Prompt 1", async () => {
    const errors = await validationErrors({
      destinationType: "individual",
      notificationsEnabled: false,
    });
    expect(errors.map((error) => error.property)).toContain("destinationType");
  });

  it("rejects unknown extra fields", async () => {
    const errors = await validationErrors({
      encryptedSessionState: "attacker-controlled",
      notificationsEnabled: false,
    });
    expect(errors.map((error) => error.property)).toContain("encryptedSessionState");
  });
});
