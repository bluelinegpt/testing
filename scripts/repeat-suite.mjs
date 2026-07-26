#!/usr/bin/env node
// Runs a test suite repeatedly, preserving the COMPLETE output of the first
// failing run. Output is never piped through a summary filter, so the failing
// test name, assertion detail and stack trace survive.
//
// Usage:
//   node scripts/repeat-suite.mjs --runs 20 --label concurrency \
//     --env RUN_CONCURRENCY_DATABASE=true -- pnpm --filter @blueline/api test:concurrency:database

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
if (separator === -1) throw new Error("Missing -- before the command to run");

const options = argv.slice(0, separator);
const command = argv.slice(separator + 1);
const read = (name, fallback) => {
  const index = options.indexOf(`--${name}`);
  return index === -1 ? fallback : options[index + 1];
};

const runs = Number(read("runs", "20"));
const label = read("label", "suite");
const environment = { ...process.env };
for (let index = 0; index < options.length; index += 1) {
  if (options[index] === "--env") {
    const [key, value] = String(options[index + 1]).split("=");
    environment[key] = value;
  }
}

const logDirectory = resolve(process.cwd(), ".test-failures");
mkdirSync(logDirectory, { recursive: true });

function runOnce(attempt) {
  return new Promise((done) => {
    const started = Date.now();
    let output = "";
    let stderr = "";
    const child = spawn(command[0], command.slice(1), {
      env: environment,
      shell: process.platform === "win32",
    });
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      output += text;
    });
    child.on("close", (code) => {
      done({ attempt, code, durationMs: Date.now() - started, output, stderr });
    });
  });
}

let failures = 0;
const durations = [];
for (let attempt = 1; attempt <= runs; attempt += 1) {
  const result = await runOnce(attempt);
  durations.push(result.durationMs);
  const status = result.code === 0 ? "pass" : "FAIL";
  process.stdout.write(`${label} run ${attempt}/${runs}: ${status} (${result.durationMs} ms)\n`);
  if (result.code !== 0) {
    failures += 1;
    const file = resolve(logDirectory, `${label}-failure-run-${attempt}.log`);
    // A header so the log is self-describing months later: what ran, which
    // iteration failed, and how long it took. Vitest's own reporter output
    // (failing file, test name, assertion, stack, DOM snapshot) follows intact.
    const header = [
      `run:        ${attempt} of ${runs}`,
      `label:      ${label}`,
      `command:    ${command.join(" ")}`,
      `cwd:        ${process.cwd()}`,
      `exit code:  ${result.code}`,
      `duration:   ${result.durationMs} ms`,
      `stderr:     ${result.stderr.length} bytes (also inline below)`,
      "".padEnd(72, "-"),
      "",
    ].join("\n");
    writeFileSync(file, header + result.output, "utf8");
    process.stdout.write(`\nComplete failure output written to ${file}\n\n`);
    // Echo the whole failure so it is never lost to a summary filter.
    process.stdout.write(result.output);
    process.stdout.write(`\nStopping on first failure at run ${attempt}.\n`);
    break;
  }
}

const total = durations.reduce((sum, value) => sum + value, 0);
process.stdout.write(
  `\n${label}: runs=${durations.length} failures=${failures} ` +
    `min=${Math.min(...durations)}ms max=${Math.max(...durations)}ms ` +
    `mean=${Math.round(total / durations.length)}ms\n`,
);
process.exitCode = failures > 0 ? 1 : 0;
