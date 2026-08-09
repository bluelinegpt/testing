import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { CategoryPills } from "../components/CategoryPills.js";
import { ProductCard } from "../components/ProductCard.js";
import { toFils } from "../lib/money.js";
import { useStore } from "../StoreContext.js";
import type { StorefrontProduct } from "../types.js";

type SortKey = "featured" | "price_asc" | "price_desc" | "name";

/**
 * Product listing with local search, category filter and sort — all operating
 * on the static sample catalogue only. The category rides in the URL so the
 * homepage pills and shared links land on a pre-filtered list.
 */
export function ProductListPage({
  onAdd,
}: {
  readonly onAdd: (product: StorefrontProduct) => void;
}) {
  const { config } = useStore();
  const categories = config.categories;
  const products = config.products;
  const [parameters, setParameters] = useSearchParams();
  const category = parameters.get("category") ?? "";
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("featured");

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = products.filter(
      (product) =>
        (category === "" || product.category === category) &&
        (query === "" ||
          product.name.toLowerCase().includes(query) ||
          product.code.toLowerCase().includes(query)),
    );
    const sorted = [...filtered];
    if (sort === "price_asc") sorted.sort((a, b) => toFils(a.price) - toFils(b.price));
    else if (sort === "price_desc") sorted.sort((a, b) => toFils(b.price) - toFils(a.price));
    else if (sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
    return sorted;
  }, [category, products, search, sort]);

  const heading =
    categories.find((entry) => entry.key === category)?.label ?? "All Products";

  return (
    <>
      <h1 style={{ fontSize: "1.5rem", margin: "6px 0 14px" }}>{heading}</h1>
      <CategoryPills active={category} />
      <div className="sf-toolbar">
        <label className="sf-field" style={{ margin: 0 }}>
          <span className="sr-only" style={{ position: "absolute", clip: "rect(0 0 0 0)" }}>
            Search products
          </span>
          <input
            aria-label="Search products"
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Search products or codes…"
            type="search"
            value={search}
          />
        </label>
        <label className="sf-field" style={{ margin: 0 }}>
          <span style={{ position: "absolute", clip: "rect(0 0 0 0)" }}>Filter by category</span>
          <select
            aria-label="Filter by category"
            onChange={(event) => {
              const next = new URLSearchParams(parameters);
              if (event.currentTarget.value === "") next.delete("category");
              else next.set("category", event.currentTarget.value);
              setParameters(next);
            }}
            value={category}
          >
            <option value="">All categories</option>
            {categories.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label className="sf-field" style={{ margin: 0 }}>
          <span style={{ position: "absolute", clip: "rect(0 0 0 0)" }}>Sort products</span>
          <select
            aria-label="Sort products"
            onChange={(event) => setSort(event.currentTarget.value as SortKey)}
            value={sort}
          >
            <option value="featured">Sort: Featured</option>
            <option value="price_asc">Price: Low to High</option>
            <option value="price_desc">Price: High to Low</option>
            <option value="name">Name A–Z</option>
          </select>
        </label>
      </div>

      {visible.length === 0 ? (
        <div className="sf-empty">
          <h2 style={{ fontSize: "1.1rem", marginBottom: 8 }}>No products found</h2>
          <p>Try a different search or category.</p>
        </div>
      ) : (
        <div className="sf-product-grid">
          {visible.map((product) => (
            <ProductCard key={product.slug} onAdd={onAdd} product={product} />
          ))}
        </div>
      )}
    </>
  );
}
