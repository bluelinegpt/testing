import { promises as fileSystem } from "node:fs";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([
  ".git",
  ".docx_review",
  ".docx_review_v2",
  ".docx_review_v3",
  "coverage",
  "dist",
  "node_modules",
]);
const ignoredFiles = new Set(["pnpm-lock.yaml"]);
const textExtensions = new Set([
  "",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const signatures = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
];

async function collectFiles(directory) {
  const files = [];
  for (const entry of await fileSystem.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    else if (
      !ignoredFiles.has(entry.name) &&
      !isLocalEnvironmentFile(entry.name) &&
      textExtensions.has(extname(entry.name))
    )
      files.push(path);
  }
  return files;
}

function isLocalEnvironmentFile(name) {
  return name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
}

const findings = [];
for (const file of await collectFiles(root)) {
  const contents = await fileSystem.readFile(file, "utf8");
  for (const signature of signatures) {
    if (signature.pattern.test(contents)) {
      findings.push(`${relative(root, file)}: possible ${signature.name}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`Secret scan failed:\n${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Secret scan passed; no supported credential signatures found.\n");
}
