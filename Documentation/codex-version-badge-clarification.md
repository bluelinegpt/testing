# Prompt for Codex — version badge / Deployment Registry clarification

Paste this into the Codex session.

---

Context on the version badge and Deployment Registry, so we stay aligned on what "version" means here going forward.

**The objective:** at any point, the user needs to open a screen locally and the same screen on Render (and later, a third environment) and directly confirm whether they're running identical code — without trusting a deploy dashboard that can lag reality.

**How it works, and why it's correct:** each app (`apps/web`, `apps/api`, `apps/platform-web`, `apps/store`) has exactly ONE version number, shown on every screen inside that app. It is NOT per-screen. Orders, Dashboard, and Trader Settlements inside `apps/web` all show the identical number, because they're all part of the same build — there's no such thing as "Orders' own version" distinct from "Dashboard's." That's expected, not a bug. Checking any one screen's badge answers the question for every screen in that app, because they all ship together.

The verification the user actually wants — "did my Orders change reach Render" — works like this: make the change, commit, the app-level number moves (e.g. `e855427` → `e924524`). Open Orders locally (badge: `e924524`), open Orders on Render. If Render's badge also reads `e924524`, confirmed live. If it still reads the old number, confirmed NOT live yet. Do not build per-screen/micro-frontend versioning — it isn't needed and isn't the objective.

**A real bug that got fixed, worth knowing about so it isn't reintroduced:** the badge (`__APP_VERSION__` in each app's `vite.config.ts`) and the Deployment Registry (`Documentation/deployment-registry.json`, via `scripts/deployment-registry.mjs`) must compute a commit the SAME way, or they disagree with each other. The badge was originally built with `git rev-parse --short HEAD` — the whole repo's tip, which in a monorepo is the same value for every app regardless of which app's folder actually changed. That's wrong: a commit that only touched `apps/api` would still change `apps/web`'s badge. Both `apps/web/vite.config.ts` and `apps/platform-web/vite.config.ts` are now fixed to use `git log -1 --format=%h -- .` (run with `cwd` set to that app's own directory) — the last commit that actually touched THAT app's folder, matching exactly what `scripts/deployment-registry.mjs`'s `currentCommitInfo()` already computes for the registry. If you add a badge to `apps/store` later, use that same `git log -1 --format=%h -- .` pattern, not `git rev-parse HEAD` — otherwise the badge and the registry row for that app will show different numbers for no visible reason, which is confusing and hard to debug from the UI alone.
