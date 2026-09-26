import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { useCustomerSession } from "../auth/customer-session-context.js";
import { useCart } from "../cart/cart-context.js";
import { storeConfiguration } from "../config/environment.js";
import {
  isLocalePrefix,
  pathWithLocale,
  useLocalePath,
  useLocalePrefix,
} from "../routing/locale-routing.js";
import { supportedLanguages } from "../localization/i18n.js";
import { OfflineBanner } from "../pwa/OfflineBanner.js";

/**
 * Marketplace shell: header, search, footer.
 *
 * ---------------------------------------------------------------------------
 * THE HEADER IS TWO LAYOUTS, NOT ONE SHRUNK
 * ---------------------------------------------------------------------------
 *
 * On a phone the search field owns its own full-width row beneath a compact
 * brand/actions row. On desktop it sits inline between them. Squeezing the
 * desktop arrangement into 375px is what produces the cramped header this pass
 * exists to fix: the search box ends up too narrow to read a placeholder in,
 * and the controls beside it fall below a comfortable tap size.
 *
 * ---------------------------------------------------------------------------
 * ACCOUNT vs CART: ONE IS REAL NOW, ONE IS STILL A PLACEHOLDER
 * ---------------------------------------------------------------------------
 *
 * Customer identity now exists (Shared Commerce Foundation Prompt 3A), so
 * Account is a real link whose destination and label follow
 * `useCustomerSession()` — "Sign In" anonymous, "My Account" authenticated
 * (§52) — never inferred from a Trader/Company/Platform cookie, which lives
 * under a completely separate origin and is never visible to this app.
 * Cart is now a real link with a live item-count badge (Customer Commerce
 * Prompt C1, §46) — the same "coming soon" control it always was, just no
 * longer disabled, since the Cart it opens now exists.
 */
export function StoreChrome({ children }: { readonly children: ReactNode }) {
  const { i18n, t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const localePath = useLocalePath();
  const localePrefix = useLocalePrefix();
  const { session } = useCustomerSession();
  const { itemCount } = useCart();

  /**
   * Switching language rewrites the URL when the URL carries a locale.
   *
   * Changing only the i18next instance would leave the shopper on `/ar/shop`
   * reading English -- and would hand them a URL that reopens in Arabic if they
   * shared it. On an unprefixed URL there is nothing to rewrite, so the toggle
   * stays purely client-side and the address the shopper arrived on is left
   * alone.
   */
  const changeLanguage = (language: string) => {
    if (localePrefix !== null && isLocalePrefix(language)) {
      void navigate(pathWithLocale(location.pathname, language) + location.search);
      return;
    }
    void i18n.changeLanguage(language);
  };

  return (
    <div className="store-shell">
      <a className="store-skip" href="#store-main">
        {t("common.skipToContent")}
      </a>

      <OfflineBanner />

      <header className="store-header">
        <div className="store-container store-header__inner">
          <Link className="store-header__brand" to={localePath("/")}>
            <span aria-hidden="true" className="store-header__mark">
              B
            </span>
            <span className="store-header__wordmark">{storeConfiguration.siteName}</span>
          </Link>

          <nav aria-label={t("categories.title")} className="store-header__nav">
            <Link className="store-header__navlink" to={localePath("/categories")}>
              {t("home.quickCategories.title")}
            </Link>
          </nav>

          <form
            className="store-search"
            onSubmit={(event) => {
              event.preventDefault();
              const query = new FormData(event.currentTarget).get("q");
              const term = typeof query === "string" ? query.trim() : "";
              if (term !== "") void navigate(localePath(`/search?q=${encodeURIComponent(term)}`));
            }}
            role="search"
          >
            <label className="store-visually-hidden" htmlFor="store-search-input">
              {t("common.search")}
            </label>
            <div className="store-search__field">
              <SearchIcon />
              <input
                className="store-search__input"
                id="store-search-input"
                name="q"
                placeholder={t("common.searchPlaceholder")}
                type="search"
              />
            </div>
            <button className="store-search__submit" type="submit">
              {t("common.search")}
            </button>
          </form>

          <div className="store-header__actions">
            <Link
              className="store-iconbutton"
              title={session.status === "authenticated" ? t("auth.account.title") : t("auth.login")}
              to={localePath(session.status === "authenticated" ? "/account" : "/login")}
            >
              <AccountIcon />
              <span className="store-iconbutton__label">
                {session.status === "authenticated" ? t("auth.account.title") : t("auth.login")}
              </span>
            </Link>
            <Link
              className="store-iconbutton store-iconbutton--cart"
              title={
                itemCount > 0
                  ? `${t("common.cart")} (${t("cart.itemCount", { count: itemCount })})`
                  : t("common.cart")
              }
              to={localePath("/cart")}
            >
              <CartIcon />
              <span className="store-iconbutton__label">{t("common.cart")}</span>
              {itemCount > 0 ? (
                <span aria-hidden="true" className="store-cartbadge">
                  {itemCount}
                </span>
              ) : null}
            </Link>

            <div aria-label={t("common.language")} className="store-langswitch" role="group">
              {supportedLanguages.map((language) => (
                <button
                  aria-pressed={i18n.language.startsWith(language)}
                  className="store-langswitch__option"
                  key={language}
                  onClick={() => {
                    changeLanguage(language);
                  }}
                  type="button"
                >
                  {language === "ar" ? t("common.arabic") : t("common.english")}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <main className="store-main" id="store-main">
        {children}
      </main>

      <footer className="store-footer">
        <div className="store-container store-footer__columns">
          <div className="store-footer__brandcol">
            <span className="store-footer__brand">
              <span aria-hidden="true" className="store-header__mark">
                B
              </span>
              {storeConfiguration.siteName}
            </span>
            <p className="store-footer__tagline">{t("footer.tagline")}</p>
          </div>

          {/*
            Only routes that actually resolve are listed. `/track`, `/support`,
            `/privacy` and `/terms` are declared reserved routes that render a
            real page; anything not yet built is absent rather than present and
            dead, because a footer link that goes nowhere is worse than a footer
            that is honestly short.
          */}
          <div>
            <h2 className="store-footer__title">{t("footer.customer")}</h2>
            <ul className="store-footer__list">
              <li>
                <Link to={localePath("/track")}>{t("footer.track")}</Link>
              </li>
              <li>
                <Link to={localePath("/support")}>{t("footer.support")}</Link>
              </li>
            </ul>
          </div>
          <div>
            <h2 className="store-footer__title">{t("footer.legal")}</h2>
            <ul className="store-footer__list">
              <li>
                <Link to={localePath("/privacy")}>{t("footer.privacy")}</Link>
              </li>
              <li>
                <Link to={localePath("/terms")}>{t("footer.terms")}</Link>
              </li>
            </ul>
          </div>
        </div>
        <div className="store-container store-footer__baseline">{t("footer.rights")}</div>
      </footer>
    </div>
  );
}

/*
 * Icons are inline SVG using `currentColor`.
 *
 * No icon font and no icon package: three glyphs do not justify a dependency,
 * and `currentColor` means they inherit the RTL-correct text colour without a
 * second set of assets. `aria-hidden` throughout — every one sits beside a real
 * text label, so announcing them would just repeat it.
 */

function SearchIcon() {
  return (
    <svg aria-hidden="true" className="store-icon" fill="none" viewBox="0 0 20 20">
      <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.7" />
      <path d="m13.5 13.5 3.5 3.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </svg>
  );
}

function AccountIcon() {
  return (
    <svg aria-hidden="true" className="store-icon" fill="none" viewBox="0 0 20 20">
      <circle cx="10" cy="7" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M4 16.5c.9-2.6 3.1-4 6-4s5.1 1.4 6 4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function CartIcon() {
  return (
    <svg aria-hidden="true" className="store-icon" fill="none" viewBox="0 0 20 20">
      <path
        d="M2.5 3h2l1.8 8.5h8.2l1.5-6H6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
      <circle cx="8" cy="16" r="1.3" fill="currentColor" />
      <circle cx="14.5" cy="16" r="1.3" fill="currentColor" />
    </svg>
  );
}
