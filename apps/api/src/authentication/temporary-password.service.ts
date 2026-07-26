import { randomBytes } from "node:crypto";

import { Injectable } from "@nestjs/common";

@Injectable()
export class TemporaryPasswordService {
  public create(): string {
    // The prefix guarantees character variety while random bytes provide the entropy.
    return `Bl!9-${randomBytes(15).toString("base64url")}`;
  }
}
