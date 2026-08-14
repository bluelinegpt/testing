import { useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { useStore } from "../StoreContext.js";

/**
 * Storefront header and footer.
 *
 * The header is the customer's whole navigation: brand, the four destinations,
 * and the cart with a live count. On mobile it collapses to a menu button and
 * a horizontal category row lives on the pages themselves. The COD ribbon is
 * permanent — Cash on Delivery is the store's only payment method and the one
 * fact every customer should absorb before checkout.
 */

export function StorefrontHeader({ cartCount }: { readonly cartCount: number }) {
  const { base, config } = useStore();
  const storeProfile = config.profile;
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const links = [
    { label: "Home", to: base },
    { label: "Products", to: `${base}/products` },
    { label: "Delivery", to: `${base}#delivery` },
    { label: "Returns", to: `${base}#returns` },
  ];
  const active = (to: string) =>
    location.pathname === to ? "sf-active" : undefined;
  return (
    <header className="sf-header">
      <div className="sf-header-bar">
        <Link className="sf-logo" to={base}>
          <span aria-hidden="true" className="sf-logo-mark">
            {storeProfile.logoInitial}
          </span>
          <span>
            <span className="sf-logo-name">{storeProfile.name}</span>
            <span className="sf-logo-tag">{storeProfile.category} · Dubai</span>
          </span>
        </Link>
        <nav aria-label="Store navigation" className="sf-header-nav">
          {links.map((link) => (
            <Link className={active(link.to)} key={link.label} to={link.to}>
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="sf-header-actions">
          <Link aria-label={`Cart, ${cartCount} item(s)`} className="sf-icon-button" to={`${base}/cart`}>
            <span aria-hidden="true">🛍</span>
            <span className="sf-cart-count">{cartCount}</span>
          </Link>
          <button
            aria-expanded={menuOpen}
            aria-label="Menu"
            className="sf-icon-button sf-mobile-toggle"
            onClick={() => setMenuOpen((open) => !open)}
            type="button"
          >
            ☰
          </button>
        </div>
      </div>
      {menuOpen ? (
        <nav aria-label="Store menu" className="sf-mobile-menu">
          {links.map((link) => (
            <Link key={link.label} onClick={() => setMenuOpen(false)} to={link.to}>
              {link.label}
            </Link>
          ))}
        </nav>
      ) : null}
      <p className="sf-cod-ribbon">
        Cash on Delivery across the UAE · Free delivery on orders over AED{" "}
        {Number.parseFloat(config.delivery.freeOverAed).toFixed(0)}
      </p>
    </header>
  );
}

export function StorefrontFooter() {
  const { base, config } = useStore();
  const storeProfile = config.profile;
  return (
    <footer className="sf-footer">
      <div className="sf-footer-grid">
        <div>
          <h3>{storeProfile.name}</h3>
          <ul>
            <li>{storeProfile.location}</li>
            <li>
              Mobile: <bdi dir="ltr">{storeProfile.mobile}</bdi>
            </li>
            <li>
              WhatsApp: <bdi dir="ltr">{storeProfile.whatsapp}</bdi>
            </li>
            <li>Payment: {storeProfile.paymentMethod} only</li>
          </ul>
        </div>
        <div>
          <h3>Opening Hours</h3>
          <ul>
            {storeProfile.hours.map((slot) => (
              <li key={slot.days}>
                {slot.days}: <bdi dir="ltr">{slot.time}</bdi>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3>Policies</h3>
          <ul>
            <li>
              <Link to={`${base}#delivery`}>Delivery information</Link>
            </li>
            <li>
              <Link to={`${base}#returns`}>Returns &amp; exchange policy</Link>
            </li>
          </ul>
        </div>
      </div>
      {/* The prototype disclaimer belongs to the SAMPLE stores and the design
          preview. On a real published Storefront it told that Trader's own
          customers that the shop was a prototype showing sample data, which is
          both untrue and damaging. `isPersisted` is set only by
          `toStoreConfig`, so the sample stores keep the disclaimer. */}
      <p className="sf-footer-legal">
        {config.isPersisted === true
          ? "Powered by TawseelHub.com delivery network."
          : "Storefront design prototype — sample data only. Powered by TawseelHub.com delivery network."}
      </p>
    </footer>
  );
}
