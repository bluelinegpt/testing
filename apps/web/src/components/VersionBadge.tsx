// The short commit SHA this build was made from, baked in by vite.config.ts's
// `define`. Declared here rather than a repo-wide vite-env.d.ts so this one
// component owns its own contract with the build config.
declare const __APP_VERSION__: string;

/**
 * A small, unobtrusive label showing which commit the running build was made
 * from -- the direct way to tell "is local actually running what I think it
 * is" and "does Render have the commit I just pushed" without trusting a
 * deploy dashboard that can lag the real build: open the app, read the
 * badge, compare.
 *
 * Placed once in `CompanyAppShell`'s shared header, next to the page title,
 * so it appears on every screen -- not added page by page. `inline` renders
 * it as part of that header's text flow; without it, the badge is a small
 * fixed corner label instead, for callers that don't have a header to sit
 * inside (e.g. a bare/embedded page).
 */
export function VersionBadge({ inline = false }: { inline?: boolean } = {}) {
  return (
    <span
      className={inline ? "version-badge version-badge-inline" : "version-badge"}
      title={`Build ${__APP_VERSION__}`}
    >
      {__APP_VERSION__}
    </span>
  );
}
