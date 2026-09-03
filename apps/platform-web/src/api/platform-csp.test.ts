/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe,expect,it } from "vitest";
describe("platform rich text security policy",()=>{
  it("allows style attributes but not inline scripts or style blocks",()=>{
    const source=readFileSync("serve.mjs","utf8");
    expect(source).toContain("style-src-attr 'unsafe-inline'");
    expect(source).toContain("style-src 'self';");
    expect(source).toContain("script-src 'self';");
    expect(source).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});
