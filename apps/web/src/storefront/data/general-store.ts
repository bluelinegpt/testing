import { gallery } from "./media.js";
import type { StoreConfig, StorefrontProduct } from "../types.js";

/**
 * Static sample Trader — Smart Market (General Products template, Clean
 * Light). PROTOTYPE DATA ONLY.
 */

const products: readonly StorefrontProduct[] = [
  {
    attributes: [
      { label: "Brand", value: "CasaLine" },
      { label: "Product Type", value: "Scented candle set" },
      { label: "Pack Size", value: "Set of 3 (oud, amber, vanilla)" },
      { label: "Dimensions", value: "8 × 9 cm each" },
    ],
    available: true,
    badges: ["featured", "best_seller"],
    category: "home",
    code: "SM-HM-101",
    colors: ["Amber Glass"],
    description:
      "A trio of long-burn scented candles in amber glass — oud, amber and vanilla — boxed and ready to gift.",
    media: gallery("Scented Candle Trio", "amber"),
    name: "Scented Candle Trio",
    price: "95.00",
    previousPrice: "120.00",
    sizes: ["Set of 3"],
    slug: "scented-candle-trio",
  },
  {
    attributes: [
      { label: "Brand", value: "DeskPro" },
      { label: "Product Type", value: "Desk organiser" },
      { label: "Material", value: "Bamboo" },
      { label: "Dimensions", value: "32 × 18 × 12 cm" },
    ],
    available: true,
    badges: ["new_arrival"],
    category: "office",
    code: "SM-OF-210",
    colors: ["Natural Bamboo"],
    description:
      "A bamboo desk organiser with phone stand, pen wells and two drawers — tidy in one move.",
    media: gallery("Bamboo Desk Organiser", "sand"),
    name: "Bamboo Desk Organiser",
    price: "79.00",
    sizes: ["One Size"],
    slug: "bamboo-desk-organiser",
  },
  {
    attributes: [
      { label: "Brand", value: "NotaBene" },
      { label: "Product Type", value: "Notebook set" },
      { label: "Pack Size", value: "3 notebooks, 192 pages each" },
      { label: "Paper", value: "100 gsm, dotted" },
    ],
    available: true,
    badges: ["best_seller"],
    category: "stationery",
    code: "SM-ST-305",
    colors: ["Navy", "Sage", "Sand"],
    description:
      "Three hardcover dotted notebooks with lay-flat binding and thick 100 gsm paper.",
    media: gallery("Dotted Notebook Set", "navy"),
    name: "Dotted Notebook Set",
    price: "65.00",
    sizes: ["A5"],
    slug: "dotted-notebook-set",
  },
  {
    attributes: [
      { label: "Brand", value: "CasaLine" },
      { label: "Product Type", value: "Photo frame set" },
      { label: "Pack Size", value: "Set of 5 mixed sizes" },
      { label: "Material", value: "Oak-finish wood" },
    ],
    available: true,
    badges: [],
    category: "gifts",
    code: "SM-GF-402",
    colors: ["Oak"],
    description:
      "Five oak-finish frames in mixed sizes for an instant gallery wall, with hanging template included.",
    media: gallery("Gallery Frame Set", "tan"),
    name: "Gallery Frame Set",
    price: "110.00",
    sizes: ["Set of 5"],
    slug: "gallery-frame-set",
  },
  {
    attributes: [
      { label: "Brand", value: "Vela" },
      { label: "Product Type", value: "Insulated bottle" },
      { label: "Capacity", value: "750 ml" },
      { label: "Keeps", value: "Cold 24 h / hot 12 h" },
    ],
    available: true,
    badges: ["new_arrival"],
    category: "personal",
    code: "SM-PR-501",
    colors: ["Sage", "Charcoal", "Blush"],
    description:
      "A double-wall stainless bottle that keeps drinks cold for 24 hours — leak-proof lid, fits car holders.",
    media: gallery("Vela Insulated Bottle", "emerald"),
    name: "Vela Insulated Bottle 750ml",
    price: "59.00",
    sizes: ["750 ml"],
    slug: "vela-insulated-bottle",
  },
  {
    attributes: [
      { label: "Brand", value: "DeskPro" },
      { label: "Product Type", value: "Laptop sleeve" },
      { label: "Fits", value: '13–14" laptops' },
      { label: "Material", value: "Recycled felt, leather trim" },
    ],
    available: false,
    badges: [],
    category: "accessories",
    code: "SM-AC-601",
    colors: ["Grey Felt"],
    description:
      "A slim felt sleeve with magnetic closure and a front pocket for chargers and cables.",
    media: gallery("Felt Laptop Sleeve", "slate"),
    name: "Felt Laptop Sleeve",
    price: "85.00",
    sizes: ['13"', '14"'],
    slug: "felt-laptop-sleeve",
  },
];

export const generalStore: StoreConfig = {
  categories: [
    { key: "home", label: "Home" },
    { key: "office", label: "Office" },
    { key: "stationery", label: "Stationery" },
    { key: "gifts", label: "Gifts" },
    { key: "personal", label: "Personal Items" },
    { key: "accessories", label: "Accessories" },
  ],
  delivery: { chargeAed: "12.00", freeOverAed: "150.00" },
  products,
  profile: {
    category: "General Products",
    description:
      "Everyday home, office and gift essentials at fair prices — practical products, quick delivery, cash on your doorstep.",
    hours: [
      { days: "Saturday – Thursday", time: "9:00 AM – 11:00 PM" },
      { days: "Friday", time: "1:00 PM – 11:00 PM" },
    ],
    location: "Ajman, United Arab Emirates",
    logoInitial: "S",
    mobile: "+971 56 222 3344",
    name: "Smart Market",
    paymentMethod: "Cash on Delivery",
    policies: {
      delivery:
        "Delivery across all seven Emirates within 1–3 working days. AED 12 delivery charge; free delivery on orders over AED 150.",
      returns: "Return unused items in original packaging within 7 days of delivery.",
    },
    slug: "smart-market",
    whatsapp: "+971 56 222 3344",
  },
  templateKey: "general",
  themeKey: "clean-light",
};
