import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

import { Injectable } from "@nestjs/common";

const KEY_LENGTH = 64;
const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N: COST, p: PARALLELIZATION, r: BLOCK_SIZE },
      (error, key) => {
        if (error === null) {
          resolve(key);
        } else {
          reject(error);
        }
      },
    );
  });
}

@Injectable()
export class PasswordHasher {
  public async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await derive(password, salt);
    return [
      "scrypt",
      COST,
      BLOCK_SIZE,
      PARALLELIZATION,
      salt.toString("base64url"),
      derived.toString("base64url"),
    ].join("$");
  }

  public async verify(password: string, encodedHash?: string): Promise<boolean> {
    const parsed = this.parse(encodedHash);
    const derived = await derive(password, parsed.salt);
    return parsed.valid && timingSafeEqual(derived, parsed.hash);
  }

  private parse(encodedHash?: string): {
    blockSize: number;
    cost: number;
    hash: Buffer;
    parallelization: number;
    salt: Buffer;
    valid: boolean;
  } {
    const parts = encodedHash?.split("$") ?? [];
    const cost = Number(parts[1]);
    const blockSize = Number(parts[2]);
    const parallelization = Number(parts[3]);
    const salt = Buffer.from(parts[4] ?? "", "base64url");
    const hash = Buffer.from(parts[5] ?? "", "base64url");
    const valid =
      parts.length === 6 &&
      parts[0] === "scrypt" &&
      cost === COST &&
      blockSize === BLOCK_SIZE &&
      parallelization === PARALLELIZATION &&
      salt.length === 16 &&
      hash.length === KEY_LENGTH;

    return valid
      ? { blockSize, cost, hash, parallelization, salt, valid }
      : {
          blockSize: BLOCK_SIZE,
          cost: COST,
          hash: Buffer.alloc(KEY_LENGTH),
          parallelization: PARALLELIZATION,
          salt: Buffer.alloc(16),
          valid: false,
        };
  }
}
