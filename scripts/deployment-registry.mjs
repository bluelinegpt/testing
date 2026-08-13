#!/usr/bin/env node
// Updates Documentation/deployment-registry.json -- the local-version-vs-Render
// status catalog shown on /administration/deployment-status. This is invoked
// by .githooks/post-commit and .githooks/pre-push, NOT run by hand in the
// normal case; those hooks are what make the registry trustworthy, since a
// written instruction to "remember to update it" is exactly the kind of step
// an agent (or a human) eventually forgets.
//
// Usage:
//   node scripts/deployment-registry.mjs mark-needs-deploy <appId>
//   node scripts/deployment-registry.mjs mark-pushed <appId>
//   node scripts/deployment-registry.mjs mark-confirmed-live <appId> [commit]
//   node scripts/deployment-registry.mjs touched-apps <fromRef> <toRef>
//     Prints the app ids (one per line) whose apps/<id> path changed between
//     two refs -- what the hooks use to decide which registry entries to touch.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const registryPath = new URL("../Documentation/deployment-registry.json", import.meta.url);

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function loadRegistry() {
  return JSON.parse(readFileSync(registryPath, "utf8"));
}

function saveRegistry(registry) {
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

function findApp(registry, appId) {
  const app = registry.apps.find((candidate) => candidate.id === appId);
  if (app === undefined) {
    throw new Error(`Unknown app id "${appId}" -- check Documentation/deployment-registry.json`);
  }
  return app;
}

// Reads the real, current state of an app's path -- never hand-typed, so it
// can't silently drift from what actually changed.
function currentCommitInfo(appPath) {
  const sha = git(["log", "-1", "--format=%h", "--", appPath]);
  const date = git(["log", "-1", "--format=%ad", "--date=short", "--", appPath]);
  const subject = git(["log", "-1", "--format=%s", "--", appPath]);
  const body = git(["log", "-1", "--format=%b", "--", appPath]);
  return { sha, date, subject, body };
}

// "Co-Authored-By: Claude Sonnet 5 <...>" / "Co-Authored-By: Codex <...>" is
// the trailer each tool actually appends -- reading it beats trusting either
// tool to separately remember to fill in a "changed by" field.
function detectAuthor(body) {
  const trailer = body.match(/Co-Authored-By:\s*(.+?)\s*</i);
  if (trailer === null) return "human";
  const name = trailer[1].toLowerCase();
  if (name.includes("claude")) return "claude";
  if (name.includes("codex")) return "codex";
  return trailer[1];
}

function touchedApps(fromRef, toRef) {
  const changed = git(["diff", "--name-only", fromRef, toRef]).split("\n").filter(Boolean);
  const registry = loadRegistry();
  const ids = new Set();
  for (const app of registry.apps) {
    if (changed.some((file) => file.startsWith(`${app.path}/`))) ids.add(app.id);
  }
  return [...ids];
}

function markNeedsDeploy(appId) {
  const registry = loadRegistry();
  const app = findApp(registry, appId);
  const info = currentCommitInfo(app.path);
  app.status = "needs_deploy";
  app.localCommit = info.sha;
  app.localCommitDate = info.date;
  app.lastChangeDescription = info.subject;
  app.lastChangeBy = detectAuthor(info.body);
  saveRegistry(registry);
  console.log(`${appId}: needs_deploy @ ${info.sha}`);
}

function markPushed(appId) {
  const registry = loadRegistry();
  const app = findApp(registry, appId);
  // Only advances past needs_deploy -- a confirmed_live app being re-pushed
  // with no local change stays confirmed_live rather than regressing.
  if (app.status === "needs_deploy") app.status = "pushed_awaiting_confirmation";
  saveRegistry(registry);
  console.log(`${appId}: ${app.status}`);
}

function markConfirmedLive(appId, commit) {
  const registry = loadRegistry();
  const app = findApp(registry, appId);
  const sha = commit ?? app.localCommit;
  app.status = "confirmed_live";
  app.confirmedLiveCommit = sha;
  app.confirmedLiveAt = new Date().toISOString().slice(0, 10);
  saveRegistry(registry);
  console.log(`${appId}: confirmed_live @ ${sha}`);
}

const [, , command, ...args] = process.argv;
switch (command) {
  case "mark-needs-deploy":
    markNeedsDeploy(args[0]);
    break;
  case "mark-pushed":
    markPushed(args[0]);
    break;
  case "mark-confirmed-live":
    markConfirmedLive(args[0], args[1]);
    break;
  case "touched-apps":
    console.log(touchedApps(args[0], args[1]).join("\n"));
    break;
  default:
    console.error(
      "Usage: deployment-registry.mjs <mark-needs-deploy|mark-pushed|mark-confirmed-live|touched-apps> ...",
    );
    process.exit(1);
}
