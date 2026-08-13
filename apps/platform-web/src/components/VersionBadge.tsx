declare const __APP_VERSION__: string;

/** Displays the short Git commit SHA baked into this Platform build by Vite. */
export function VersionBadge() {
  return (
    <span className="platform-version-badge" title={`Build ${__APP_VERSION__}`}>
      {__APP_VERSION__}
    </span>
  );
}
