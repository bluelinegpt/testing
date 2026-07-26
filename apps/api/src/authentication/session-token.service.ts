import { createHash, randomBytes } from "node:crypto";

import { Injectable } from "@nestjs/common";

@Injectable()
export class SessionTokenService {
  public create(): { hash: string; token: string } {
    const token = randomBytes(32).toString("base64url");
    return { hash: this.hash(token), token };
  }

  public hash(token: string): string {
    return createHash("sha256").update(token, "utf8").digest("hex");
  }
}
