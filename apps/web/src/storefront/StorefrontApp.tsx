import { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { StorefrontFooter, StorefrontHeader } from "./components/StorefrontChrome.js";
import {
  fetchPublicProduct,
  fetchPublicProducts,
  resolvePublicStorefront,
  toStoreConfig,
  toStorefrontProduct,
  type PublicProduct,
  type PublicStorefront,
} from "./lib/public-storefront.js";
import { CartPage } from "./pages/CartPage.js";
import { CheckoutPage } from "./pages/CheckoutPage.js";
import { ConfirmationPage } from "./pages/ConfirmationPage.js";
import { HomePage } from "./pages/HomePage.js";
import { PreviewPage } from "./pages/PreviewPage.js";
import { ProductDetailPage } from "./pages/ProductDetailPage.js";
import { ProductListPage } from "./pages/ProductListPage.js";
import { ReviewPage } from "./pages/ReviewPage.js";
import { StoreContext, activeStoreFor } from "./StoreContext.js";
import {
  emptyCheckout,
  type CartLine,
  type CheckoutDetails,
  type StorefrontThemeKey,
} from "./types.js";
import { storefrontThemes } from "./themes/index.js";
import "./styles/storefront.css";

/**
 * Trader Storefront — public shop pages.
 *
 * ===========================================================================
 * ISOLATION
 * ===========================================================================
 *
 * Mounted by `App.tsx` for `/store/...` and `/storefront-preview` BEFORE any
 * session handling, so these public paths never inherit the portal shell and a
 * signed-in user never gets the portal wrapped around a store page. The ONLY
 * call made here is the unauthenticated public Storefront resolution: no
 * session is read and no bearer token is sent. Every style is `sf-`-scoped and
 * theme tokens are
 * applied as inline CSS custom properties on `.sf-root` — never on `:root`,
 * `html` or `body` — so no theme value can reach a portal page.
 *
 * ===========================================================================
 * ONE FLOW, REAL PROFILES, SAMPLE CATALOGUES
 * ===========================================================================
 *
 * The slug is resolved by the API, and the persisted Storefront supplies the
 * name, template, theme, branding, contact details, policies and open/closed
 * status. The CATALOGUE is still the static sample set — Products arrive in
 * Prompt 4 — and it is selected by the real Storefront's business template.
 *
 * There is no fallback to a sample Trader. A slug that does not resolve, or
 * that belongs to a draft, unpublished or suspended shop, shows the same
 * store-not-found state and never falls through to application pages.
 *
 * ===========================================================================
 * NOTHING PERSISTS
 * ===========================================================================
 *
 * Cart, checkout details and the preview-theme override are React state:
 * refresh and they are gone. Nothing is written to any storage, and no
 * personal data ever rides in a URL. Switching stores clears the cart — a
 * cart belongs to one Trader.
 */

type StorefrontRoute =
  | { readonly kind: "cart" }
  | { readonly kind: "checkout" }
  | { readonly kind: "confirmation" }
  | { readonly kind: "home" }
  | { readonly kind: "preview" }
  | { readonly kind: "product"; readonly slug: string }
  | { readonly kind: "products" }
  | { readonly kind: "review" }
  | { readonly kind: "unknown-store" };

function parseRoute(pathname: string): { route: StorefrontRoute; storeSlug: string } {
  if (pathname === "/storefront-preview" || pathname.startsWith("/storefront-preview/")) {
    return { route: { kind: "preview" }, storeSlug: "" };
  }
  const parts = pathname.replace(/^\/store\/?/, "").split("/").filter(Boolean);
  const [slug = "", section, detail] = parts;
  // Whether a slug exists is the API's answer, not the router's. An empty slug
  // is the one case decidable here.
  if (slug === "") {
    return { route: { kind: "unknown-store" }, storeSlug: "" };
  }
  if (section === undefined) return { route: { kind: "home" }, storeSlug: slug };
  if (section === "products" && detail !== undefined) {
    return { route: { kind: "product", slug: decodeURIComponent(detail) }, storeSlug: slug };
  }
  if (section === "products") return { route: { kind: "products" }, storeSlug: slug };
  if (section === "cart") return { route: { kind: "cart" }, storeSlug: slug };
  if (section === "checkout") return { route: { kind: "checkout" }, storeSlug: slug };
  if (section === "review") return { route: { kind: "review" }, storeSlug: slug };
  if (section === "confirmation") return { route: { kind: "confirmation" }, storeSlug: slug };
  return { route: { kind: "home" }, storeSlug: slug };
}

export function StorefrontApp() {
  const location = useLocation();
  const navigate = useNavigate();
  const { route, storeSlug } = parseRoute(location.pathname);
  const [lines, setLines] = useState<readonly CartLine[]>([]);
  const [checkout, setCheckout] = useState<CheckoutDetails>(emptyCheckout);
  const [confirmed, setConfirmed] = useState(false);
  // Memory only, reset on refresh — the design-preview theme override.
  const [themeOverride, setThemeOverride] = useState<StorefrontThemeKey>();
  // The persisted Storefront behind this address. `undefined` while the answer
  // is still outstanding, so a customer never sees "not found" during a load.
  const [resolution, setResolution] = useState<
    { readonly kind: "error" } | { readonly kind: "found"; readonly storefront: PublicStorefront } | { readonly kind: "not-found" } | undefined
  >();

  // The real catalogue. `undefined` means "not answered yet"; an empty array
  // is a genuine empty shop and is rendered as such.
  const [catalogue, setCatalogue] = useState<readonly PublicProduct[]>();
  /** The open Product's full record, fetched only on a detail route. */
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof fetchPublicProduct>>>();

  useEffect(() => {
    if (route.kind === "preview" || storeSlug === "") return;
    const controller = new AbortController();
    setResolution(undefined);
    setCatalogue(undefined);
    void resolvePublicStorefront(storeSlug, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setResolution(result);
      if (result.kind !== "found") return;
      void fetchPublicProducts(storeSlug, controller.signal).then((products) => {
        // A failed catalogue fetch yields an empty shop, never sample goods.
        if (!controller.signal.aborted) setCatalogue(products?.items ?? []);
      });
    });
    return () => controller.abort();
  }, [route.kind, storeSlug]);

  // `parseRoute` builds a fresh object every render, so this effect depends on
  // PRIMITIVES. Depending on the route object re-ran it on every render, which
  // reset the fetched detail before it could ever be used.
  const detailSlug = route.kind === "product" ? route.slug : "";
  useEffect(() => {
    if (detailSlug === "" || storeSlug === "") {
      setDetail(undefined);
      return;
    }
    const controller = new AbortController();
    setDetail(undefined);
    void fetchPublicProduct(storeSlug, detailSlug, controller.signal).then((value) => {
      if (!controller.signal.aborted) setDetail(value);
    });
    return () => controller.abort();
  }, [detailSlug, storeSlug]);

  // A retired address redirects ONCE to the Storefront's current one. The
  // canonical slug always resolves live, so this cannot bounce.
  useEffect(() => {
    if (resolution?.kind !== "found") return;
    const canonical = resolution.storefront.canonicalSlug;
    if (canonical === undefined || canonical === storeSlug) return;
    void navigate(location.pathname.replace(`/store/${storeSlug}`, `/store/${canonical}`), {
      replace: true,
    });
  }, [location.pathname, navigate, resolution, storeSlug]);

  // A storefront customer expects each screen to start at the top.
  useEffect(() => {
    globalThis.scrollTo({ top: 0 });
  }, [location.pathname]);

  // A cart belongs to one Trader: switching sample stores starts fresh.
  useEffect(() => {
    setLines([]);
    setCheckout(emptyCheckout);
    setConfirmed(false);
  }, [storeSlug]);

  const add = (slug: string, size: string, color: string, quantity: number) => {
    setLines((current) => {
      const existing = current.find(
        (line) => line.slug === slug && line.size === size && line.color === color,
      );
      if (existing === undefined) return [...current, { color, quantity, size, slug }];
      return current.map((line) =>
        line === existing ? { ...line, quantity: Math.min(9, line.quantity + quantity) } : line,
      );
    });
  };

  const cartCount = lines.reduce((sum, line) => sum + line.quantity, 0);

  // The preview page renders in the neutral default (Luxury Minimal) look.
  if (route.kind === "preview") {
    return (
      <div className="sf-root" dir="ltr" lang="en">
        <main className="sf-main">
          <PreviewPage onThemeOverride={setThemeOverride} themeOverride={themeOverride} />
        </main>
      </div>
    );
  }

  const shell = (body: ReactElement) => (
    <div className="sf-root" dir="ltr" lang="en">
      <main className="sf-main">{body}</main>
    </div>
  );

  // A draft, unpublished, suspended, unknown or malformed address all land
  // here, with one wording. Telling them apart would confirm which slugs exist.
  if (route.kind === "unknown-store" || resolution?.kind === "not-found") {
    return shell(
      <div className="sf-empty">
        <h1 style={{ fontSize: "1.25rem", marginBottom: 8 }}>Store not found</h1>
        <p>This storefront link does not exist. Please check the address you were sent.</p>
      </div>,
    );
  }

  if (resolution === undefined) {
    return shell(
      <div className="sf-empty" role="status">
        <p>Loading store…</p>
      </div>,
    );
  }

  if (resolution.kind === "error") {
    // Explicitly NOT "not found": the shop may be perfectly fine and the
    // network was not.
    return shell(
      <div className="sf-empty" role="alert">
        <h1 style={{ fontSize: "1.25rem", marginBottom: 8 }}>Store unavailable</h1>
        <p>This store could not be loaded right now. Please try again shortly.</p>
      </div>,
    );
  }

  if (catalogue === undefined) {
    return shell(
      <div className="sf-empty" role="status">
        <p>Loading store…</p>
      </div>,
    );
  }

  // The persisted profile AND the persisted catalogue. Sample Products are no
  // longer reachable from /store/:slug at all.
  // On a detail route the open Product is rebuilt from its full record, so the
  // gallery, video and option groups come from the detail endpoint rather than
  // the list item's single primary image.
  const config = toStoreConfig(
    resolution.storefront,
    catalogue.map((product) =>
      detail != null && product.slug === detail.slug
        ? toStorefrontProduct(product, detail)
        : toStorefrontProduct(product),
    ),
  );
  const store = activeStoreFor(config, themeOverride);
  const closed = resolution.storefront.status === "temporarily_closed";
  // Theme tokens as inline custom properties on the storefront root ONLY.
  const themeStyle = storefrontThemes[themeOverride ?? config.themeKey].tokens as CSSProperties;

  let content;
  switch (route.kind) {
    case "products":
      content = (
        <ProductListPage
          onAdd={(product) => add(product.slug, product.sizes[0] ?? "", product.colors[0] ?? "", 1)}
        />
      );
      break;
    case "product":
      content = <ProductDetailPage key={route.slug} onAdd={add} slug={route.slug} />;
      break;
    case "cart":
      content = (
        <CartPage
          lines={lines}
          onQuantity={(line, quantity) =>
            setLines((current) =>
              current.map((entry) => (entry === line ? { ...entry, quantity } : entry)),
            )
          }
          onRemove={(line) => setLines((current) => current.filter((entry) => entry !== line))}
        />
      );
      break;
    case "checkout":
      content = <CheckoutPage details={checkout} lines={lines} onSubmit={setCheckout} />;
      break;
    case "review":
      content = (
        <ReviewPage details={checkout} lines={lines} onConfirm={() => setConfirmed(true)} />
      );
      break;
    case "confirmation":
      content = confirmed ? (
        <ConfirmationPage details={checkout} lines={lines} />
      ) : (
        <div className="sf-empty">
          <h1 style={{ fontSize: "1.2rem", marginBottom: 8 }}>No confirmed order</h1>
          <p>Complete checkout and confirm your order first.</p>
        </div>
      );
      break;
    default:
      content = (
        <HomePage
          onAdd={(product) => add(product.slug, product.sizes[0] ?? "", product.colors[0] ?? "", 1)}
        />
      );
  }

  return (
    <StoreContext.Provider value={store}>
      <div className="sf-root" dir="ltr" lang="en" style={themeStyle}>
        <StorefrontHeader cartCount={cartCount} />
        {closed ? (
          // A temporarily closed shop stays readable — customers should see
          // that it is closed, not that it is gone. Blocking cart actions
          // belongs to the cart work and is not implemented here.
          <div className="sf-empty" role="status">
            <strong>This store is temporarily closed.</strong>
            <p>You can browse the store, but new orders are not being taken right now.</p>
          </div>
        ) : null}
        <main className="sf-main">{content}</main>
        <StorefrontFooter />
      </div>
    </StoreContext.Provider>
  );
}
