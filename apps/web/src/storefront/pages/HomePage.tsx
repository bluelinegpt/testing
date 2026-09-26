import { Link } from "react-router-dom";

import { CategoryPills } from "../components/CategoryPills.js";
import { ProductCard } from "../components/ProductCard.js";
import { useStore } from "../StoreContext.js";
import type { StorefrontProduct } from "../types.js";

/**
 * Store homepage: hero, categories, three curated shelves, trust strip, and
 * the delivery/returns policy blocks the footer links anchor to.
 */
export function HomePage({ onAdd }: { readonly onAdd: (product: StorefrontProduct) => void }) {
  const { base, config, template } = useStore();
  const storeProfile = config.profile;
  const products = config.products;
  /**
   * Badges are curation, not a prerequisite for having a shop window.
   *
   * The sample catalogues tag every product, but a REAL catalogue carries no
   * badges until a Trader sets them — and keying the shelves purely on badges
   * left a published store with live Products showing an entirely empty home
   * page. The featured shelf therefore falls back to the first few Products in
   * their saved display order; the other shelves stay curation-only, so
   * nothing is invented where the Trader has expressed no preference.
   */
  const shelf = (badge: "featured" | "best_seller" | "new_arrival") => {
    const tagged = products.filter((product) => product.badges.includes(badge)).slice(0, 4);
    if (tagged.length > 0 || badge !== "featured") return tagged;
    return products.slice(0, 4);
  };
  // Shelf titles come from the business template — vocabulary, not layout.
  const shelves = [
    { items: shelf("featured"), key: "featured", title: template.shelves.featured },
    { items: shelf("best_seller"), key: "best", title: template.shelves.bestSellers },
    { items: shelf("new_arrival"), key: "new", title: template.shelves.newArrivals },
  ];
  return (
    <>
      <section aria-label="Welcome" className="sf-hero">
        <p className="sf-hero-note">{storeProfile.category} · {storeProfile.location}</p>
        <h1>{storeProfile.name}</h1>
        <p>{storeProfile.description}</p>
        <div className="sf-hero-actions">
          <Link className="sf-button" to={`${base}/products`}>
            Shop the Collection
          </Link>
          <a
            className="sf-button sf-button-ghost"
            href={`https://wa.me/${storeProfile.whatsapp.replaceAll(/[^0-9]/g, "")}`}
            rel="noreferrer"
            target="_blank"
          >
            WhatsApp Us
          </a>
        </div>
      </section>

      <section className="sf-section" aria-label="Browse by category">
        <CategoryPills />
      </section>

      {shelves.map((section) =>
        section.items.length === 0 ? null : (
          <section className="sf-section" key={section.key}>
            <div className="sf-section-head">
              <h2>{section.title}</h2>
              <Link to={`${base}/products`}>View all</Link>
            </div>
            <div className="sf-product-grid">
              {section.items.map((product) => (
                <ProductCard key={product.slug} onAdd={onAdd} product={product} />
              ))}
            </div>
          </section>
        ),
      )}

      <section aria-label="Why shop with us" className="sf-section">
        <div className="sf-trust-grid">
          <div className="sf-info-card">
            <h3>💵 Cash on Delivery</h3>
            <p>Pay only when your order arrives at your door. No cards needed.</p>
          </div>
          <div className="sf-info-card">
            <h3>🚚 UAE-wide Delivery</h3>
            <p>1–3 working days to all seven Emirates through our delivery partner.</p>
          </div>
          <div className="sf-info-card">
            <h3>↩ 7-Day Exchange</h3>
            <p>Changed your mind? Exchange or return within 7 days, tags attached.</p>
          </div>
          <div className="sf-info-card">
            <h3>💬 Real Support</h3>
            <p>
              Message us on WhatsApp <bdi dir="ltr">{storeProfile.whatsapp}</bdi> — we reply during
              store hours.
            </p>
          </div>
        </div>
      </section>

      <section className="sf-section" id="delivery">
        <div className="sf-info-card">
          <h3>Delivery Information</h3>
          <p>{storeProfile.policies.delivery}</p>
        </div>
      </section>
      <section className="sf-section" id="returns">
        <div className="sf-info-card">
          <h3>Return &amp; Exchange Policy</h3>
          <p>{storeProfile.policies.returns}</p>
        </div>
      </section>

      <section aria-label="Business hours" className="sf-section">
        <div className="sf-info-card">
          <h3>Business Hours</h3>
          <ul>
            {storeProfile.hours.map((slot) => (
              <li key={slot.days}>
                {slot.days}: <bdi dir="ltr">{slot.time}</bdi>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
