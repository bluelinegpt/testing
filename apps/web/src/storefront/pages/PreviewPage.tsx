import { Link } from "react-router-dom";

import { sampleStores } from "../data/stores.js";
import { storefrontTemplates } from "../templates/index.js";
import { storefrontThemes } from "../themes/index.js";
import type { StorefrontThemeKey } from "../types.js";

/**
 * `/storefront-preview` — PROTOTYPE-ONLY design preview.
 *
 * Lists the four sample stores with their business template and visual theme,
 * and offers a theme override that lives in React state in the shell: memory
 * only, applied to every store link until the page is refreshed, persisted
 * nowhere (no database, no localStorage, no sessionStorage, no cookies, no
 * URL). This page is not linked from the office navigation and exposes no
 * application data.
 */
export function PreviewPage({
  onThemeOverride,
  themeOverride,
}: {
  readonly onThemeOverride: (key: StorefrontThemeKey | undefined) => void;
  readonly themeOverride: StorefrontThemeKey | undefined;
}) {
  const themes = Object.values(storefrontThemes);
  return (
    <>
      <div className="sf-preview-banner" role="note">
        Design preview — prototype only. Sample stores, sample data, no real orders.
      </div>
      <h1 style={{ fontSize: "1.5rem", marginBottom: 6 }}>Trader Storefront Design Preview</h1>
      <p style={{ color: "var(--sf-muted)", marginTop: 0 }}>
        Four sample stores demonstrate the business templates and visual themes. Open any store,
        or preview all of them in a different theme below — the choice resets on refresh.
      </p>

      <div className="sf-section" role="group" aria-label="Preview theme override">
        <h2 style={{ fontSize: "1.05rem", marginBottom: 10 }}>Preview theme</h2>
        <div className="sf-choice-row">
          <button
            aria-pressed={themeOverride === undefined}
            className={`sf-choice${themeOverride === undefined ? " sf-active" : ""}`}
            onClick={() => onThemeOverride(undefined)}
            type="button"
          >
            Each store's own theme
          </button>
          {themes.map((theme) => (
            <button
              aria-pressed={themeOverride === theme.key}
              className={`sf-choice${themeOverride === theme.key ? " sf-active" : ""}`}
              key={theme.key}
              onClick={() => onThemeOverride(theme.key)}
              type="button"
            >
              {theme.label}
            </button>
          ))}
        </div>
      </div>

      <div className="sf-section sf-preview-grid">
        {sampleStores.map((store) => {
          const theme = storefrontThemes[themeOverride ?? store.themeKey];
          const template = storefrontTemplates[store.templateKey];
          return (
            <article className="sf-preview-card" key={store.profile.slug}>
              <h2 style={{ fontSize: "1.1rem" }}>{store.profile.name}</h2>
              <p style={{ color: "var(--sf-muted)", fontSize: "0.85rem", margin: 0 }}>
                {template.label} template · {theme.label} theme
                {themeOverride !== undefined && themeOverride !== store.themeKey
                  ? " (override)"
                  : ""}
              </p>
              <div aria-hidden="true" className="sf-preview-swatches">
                <span style={{ background: theme.tokens["--sf-chrome-bg"] }} />
                <span style={{ background: theme.tokens["--sf-gold"] }} />
                <span style={{ background: theme.tokens["--sf-bg"] }} />
                <span style={{ background: theme.tokens["--sf-surface"] }} />
              </div>
              <p style={{ color: "var(--sf-muted)", fontSize: "0.82rem" }}>
                {store.profile.description}
              </p>
              <Link className="sf-button" to={`/store/${store.profile.slug}`}>
                Open storefront
              </Link>
            </article>
          );
        })}
      </div>
    </>
  );
}
