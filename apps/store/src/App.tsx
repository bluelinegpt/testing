import { Route, Routes } from "react-router-dom";

import { StoreChrome } from "./components/StoreChrome.js";
import { storeConfiguration } from "./config/environment.js";
import { LocaleScope } from "./routing/locale-routing.js";
import type { SupportedLanguage } from "./localization/i18n.js";
import { AccountPage } from "./pages/AccountPage.js";
import { CartPage } from "./pages/CartPage.js";
import { CheckoutPage } from "./pages/CheckoutPage.js";
import {
  CategoriesPage,
  CategoryDetailPage,
  SubcategoryPage,
} from "./pages/CategoryPages.js";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { MarketplaceHomePage } from "./pages/MarketplaceHomePage.js";
import { MyOrdersPage } from "./pages/MyOrdersPage.js";
import { OrderConfirmationPage } from "./pages/OrderConfirmationPage.js";
import { OrderDetailPage } from "./pages/OrderDetailPage.js";
import { ProductPage } from "./pages/ProductPage.js";
import { RegisterPage } from "./pages/RegisterPage.js";
import { ResetPasswordPage } from "./pages/ResetPasswordPage.js";
import { ReservedRoutePage } from "./pages/ReservedRoutePage.js";
import { StorePage } from "./pages/StorePage.js";
import { TrackPage } from "./pages/TrackPage.js";
import { MessageState } from "./components/States.js";

/**
 * Store routing.
 *
 * The reserved routes are declared BEFORE the `/:storeSlug` catch-all so React
 * Router matches them first. `reserved-slugs.ts` is the second half of the same
 * guarantee: it stops a shop from ever being created at one of these words, and
 * these declarations stop such a shop from being resolved if one somehow slips
 * through.
 *
 * Every route is a real URL with no hash and no modal-only state, so each one
 * deep-links, survives a reload and can later be a share target or a PWA entry
 * point without rework.
 */
export function App() {
  if (!storeConfiguration.features.storePublicEnabled) {
    return (
      <StoreChrome>
        <div className="store-container">
          <MessageState
            bodyKey="errors.apiUnavailable.body"
            titleKey="errors.apiUnavailable.title"
          />
        </div>
      </StoreChrome>
    );
  }

  return (
    <Routes>
      <Route element={<LocalisedRoutes locale="en" />} path="/en/*" />
      <Route element={<LocalisedRoutes locale="ar" />} path="/ar/*" />
      <Route element={<LocalisedRoutes locale={null} />} path="/*" />
    </Routes>
  );
}

/**
 * The route table, mounted once per locale prefix and once unprefixed.
 *
 * Paths here are RELATIVE — no leading slash — so React Router resolves them
 * against whichever prefix matched. One table, three mount points: an `/ar`
 * route that existed only because someone remembered to add it in two places is
 * a route that will eventually exist in only one.
 */
function LocalisedRoutes({ locale }: { readonly locale: SupportedLanguage | null }) {
  return (
    <LocaleScope locale={locale}>
      <StoreChrome>
        <Routes>
        <Route
          element={
            storeConfiguration.features.marketplaceHomeEnabled ? (
              <MarketplaceHomePage />
            ) : (
              <ReservedRoutePage />
            )
          }
          path=""
        />
        <Route element={<CategoriesPage />} path="categories" />
        <Route element={<CategoryDetailPage />} path="categories/:categorySlug" />
        <Route
          element={<SubcategoryPage />}
          path="categories/:categorySlug/:subcategorySlug"
        />
        <Route element={<RegisterPage />} path="register" />
        <Route element={<LoginPage />} path="login" />
        <Route element={<ForgotPasswordPage />} path="forgot-password" />
        <Route element={<ResetPasswordPage />} path="reset-password" />
        <Route element={<AccountPage />} path="account" />
        <Route element={<MyOrdersPage />} path="account/orders" />
        <Route element={<OrderDetailPage />} path="account/orders/:storeOrderNumber" />
        <Route element={<TrackPage />} path="track" />
        <Route element={<CartPage />} path="cart" />
        <Route element={<CheckoutPage />} path="checkout" />
        <Route element={<OrderConfirmationPage />} path="order-confirmation/:storeOrderNumber" />
        {["search", "support", "privacy", "terms"].map((path) => (
          <Route element={<ReservedRoutePage />} key={path} path={path} />
        ))}
        <Route element={<ProductPage />} path=":storeSlug/products/:productSlug" />
        <Route element={<StorePage />} path=":storeSlug" />
        <Route
          element={
            <div className="store-container">
              <MessageState
                bodyKey="errors.storeNotFound.body"
                titleKey="errors.storeNotFound.title"
              />
            </div>
          }
          path="*"
        />
        </Routes>
      </StoreChrome>
    </LocaleScope>
  );
}
