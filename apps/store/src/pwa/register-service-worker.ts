/**
 * Service worker registration -- Prompt 3D §13-15.
 *
 * Optional and non-blocking: Store browsing works identically with or
 * without a service worker (§13 "do not claim universal installation
 * across browsers"; §14 "never block Store browsing"). Registration is
 * skipped entirely outside a production build (`import.meta.env.PROD`) so
 * Vite's dev server -- which serves unhashed, constantly-changing modules --
 * is never at risk of a stale cache confusing local development.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // A failed registration must never break the page -- the app already
      // works fully without one.
    });
  });
}
