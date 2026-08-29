import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom";
import { App } from "./App";
import { PreloadContext, type PreloadMap } from "./preload-context";

/**
 * The one and only Node-side render entry point.
 *
 * This is plain Vite SSR (`vite build --ssr`), the pattern documented in
 * Vite's own guide -- not Next.js, not a second router. It renders the
 * exact same <App/> component tree and the exact same react-router routes
 * the browser uses, swapping only the router implementation: `StaticRouter`
 * (no `window.history`, takes a fixed `location`) in place of the client's
 * `BrowserRouter`. `scripts/prerender.mjs` is the only caller -- this module
 * is never shipped to the browser.
 */
export function render(url: string, preloadMap: PreloadMap): string {
  return renderToString(
    <PreloadContext.Provider value={preloadMap}>
      <StaticRouter location={url}>
        <App />
      </StaticRouter>
    </PreloadContext.Provider>,
  );
}
