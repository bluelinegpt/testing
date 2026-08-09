import { Link } from "react-router-dom";

import { useStore } from "../StoreContext.js";

/**
 * Horizontal, swipeable category row. Rendered as links to the listing page
 * with the category preselected, so a customer can jump from anywhere.
 */
export function CategoryPills({ active }: { readonly active?: string | undefined }) {
  const { base, config } = useStore();
  const categories = config.categories;
  return (
    <nav aria-label="Product categories" className="sf-category-row">
      <Link
        className={`sf-category-pill${active === undefined || active === "" ? " sf-active" : ""}`}
        to={`${base}/products`}
      >
        All
      </Link>
      {categories.map((category) => (
        <Link
          className={`sf-category-pill${active === category.key ? " sf-active" : ""}`}
          key={category.key}
          to={`${base}/products?category=${category.key}`}
        >
          {category.label}
        </Link>
      ))}
    </nav>
  );
}
