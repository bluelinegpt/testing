import { gallery, image, video } from "./media.js";
import type { StoreConfig, StorefrontProduct } from "../types.js";

/**
 * Static sample Trader — Al Noor Fashion (Fashion template, Luxury Minimal).
 *
 * The Prompt 1 catalogue, unchanged in content, now carried as a StoreConfig
 * so the shared storefront can serve four sample stores from one flow.
 * PROTOTYPE DATA ONLY — nothing here touches the backend or real records.
 */

const products: readonly StorefrontProduct[] = [
  {
    attributes: [
      { label: "Material", value: "Premium crepe with gold-thread embroidery" },
      { label: "Fit", value: "Relaxed, full-length" },
      { label: "Gender", value: "Women" },
      { label: "Style", value: "Occasion abaya" },
      { label: "Care", value: "Dry clean or gentle hand wash, cool iron" },
    ],
    available: true,
    badges: ["featured", "best_seller"],
    category: "abayas",
    code: "ANF-AB-001",
    colors: ["Black", "Midnight Blue"],
    description:
      "A flowing crepe abaya with hand-finished gold thread embroidery along the cuffs and hem. Lightweight, breathable and cut for an elegant drape.",
    media: [
      ...gallery("Embroidered Abaya", "noir"),
      image("Embroidered Abaya — embroidery close-up", "noir-5"),
      video("Embroidered Abaya — fabric in motion", "noir"),
    ],
    name: "Embroidered Abaya",
    previousPrice: "520.00",
    price: "429.00",
    sizes: ["52", "54", "56", "58"],
    slug: "embroidered-abaya",
  },
  {
    available: true,
    badges: ["new_arrival"],
    category: "abayas",
    code: "ANF-AB-002",
    colors: ["Sand", "Olive"],
    description:
      "A relaxed linen-blend abaya for everyday wear. Naturally cool, softly structured, with concealed side pockets.",
    media: gallery("Linen Abaya", "sand"),
    name: "Linen Abaya",
    price: "349.00",
    sizes: ["52", "54", "56", "58"],
    slug: "linen-abaya",
  },
  {
    attributes: [
      { label: "Material", value: "Two-fold 100% cotton" },
      { label: "Fit", value: "Tailored" },
      { label: "Gender", value: "Men" },
      { label: "Care", value: "Machine wash 30°, easy iron" },
    ],
    available: true,
    badges: ["best_seller"],
    category: "men",
    code: "ANF-MN-010",
    colors: ["White", "Sky Blue"],
    description:
      "A premium two-fold cotton shirt with a structured collar and mother-of-pearl buttons. Tailored fit, easy iron.",
    media: gallery("Premium Cotton Shirt", "sky"),
    name: "Premium Cotton Shirt",
    previousPrice: "220.00",
    price: "179.00",
    sizes: ["S", "M", "L", "XL", "XXL"],
    slug: "premium-cotton-shirt",
  },
  {
    available: true,
    badges: [],
    category: "men",
    code: "ANF-MN-014",
    colors: ["Charcoal", "Camel"],
    description:
      "A light bomber-style jacket in brushed twill — an easy layer for cool evenings and air-conditioned days alike.",
    media: gallery("Casual Jacket", "slate"),
    name: "Casual Jacket",
    price: "259.00",
    sizes: ["S", "M", "L", "XL"],
    slug: "casual-jacket",
  },
  {
    available: true,
    badges: ["featured", "new_arrival"],
    category: "kids",
    code: "ANF-KD-021",
    colors: ["Blush", "Ivory"],
    description:
      "A twirl-ready floral dress in soft cotton with a lined bodice and gentle elastic back. Machine washable.",
    media: gallery("Girls Floral Dress", "blush"),
    name: "Girls Floral Dress",
    price: "129.00",
    sizes: ["2–3Y", "4–5Y", "6–7Y", "8–9Y"],
    slug: "girls-floral-dress",
  },
  {
    available: true,
    badges: [],
    category: "kids",
    code: "ANF-KD-024",
    colors: ["Navy", "White"],
    description:
      "An everyday cotton T-shirt with a soft hand-feel and reinforced shoulder seams. Made to survive the playground.",
    media: gallery("Boys T-Shirt", "navy"),
    name: "Boys T-Shirt",
    price: "59.00",
    sizes: ["2–3Y", "4–5Y", "6–7Y", "8–9Y"],
    slug: "boys-t-shirt",
  },
  {
    available: true,
    badges: ["best_seller"],
    category: "shoes",
    code: "ANF-SH-031",
    colors: ["White"],
    description:
      "A clean leather sneaker with a cushioned insole and stitched cup sole. Goes with everything, dresses up or down.",
    media: [
      ...gallery("Classic White Sneakers", "cloud"),
      image("Classic White Sneakers — sole", "cloud-5"),
    ],
    name: "Classic White Sneakers",
    previousPrice: "320.00",
    price: "269.00",
    sizes: ["38", "39", "40", "41", "42", "43", "44"],
    slug: "classic-white-sneakers",
  },
  {
    available: true,
    badges: ["featured"],
    category: "bags",
    code: "ANF-BG-041",
    colors: ["Tan", "Black"],
    description:
      "A structured shoulder bag in pebbled vegan leather with gold-tone hardware, a magnetic flap and an interior zip pocket.",
    media: gallery("Shoulder Bag", "tan"),
    name: "Shoulder Bag",
    price: "199.00",
    sizes: ["One Size"],
    slug: "shoulder-bag",
  },
  {
    available: false,
    badges: [],
    category: "accessories",
    code: "ANF-AC-051",
    colors: ["Gold / Brown"],
    description:
      "Oversized square sunglasses with UV400 lenses and slim gold-tone temples. Includes a hard case and cleaning cloth.",
    media: gallery("Sunglasses", "amber"),
    name: "Sunglasses",
    price: "149.00",
    sizes: ["One Size"],
    slug: "sunglasses",
  },
  {
    available: true,
    badges: ["new_arrival"],
    category: "women",
    code: "ANF-WM-061",
    colors: ["Emerald", "Deep Plum"],
    description:
      "A modest evening dress in heavy satin with a high neckline, full-length sleeves and a softly flared hem.",
    media: [
      ...gallery("Modest Evening Dress", "emerald"),
      image("Modest Evening Dress — fabric sheen", "emerald-5"),
      image("Modest Evening Dress — sleeve", "emerald-6"),
    ],
    name: "Modest Evening Dress",
    previousPrice: "640.00",
    price: "549.00",
    sizes: ["S", "M", "L", "XL"],
    slug: "modest-evening-dress",
  },
  {
    available: true,
    badges: [],
    category: "women",
    code: "ANF-WM-064",
    colors: ["Dusty Rose", "Stone"],
    description:
      "A relaxed maxi dress in crinkle viscose with side pockets and a self-tie belt. Effortless from morning to evening.",
    media: gallery("Everyday Maxi Dress", "rose"),
    name: "Everyday Maxi Dress",
    price: "219.00",
    sizes: ["S", "M", "L", "XL"],
    slug: "everyday-maxi-dress",
  },
  {
    available: true,
    badges: ["best_seller"],
    category: "accessories",
    code: "ANF-AC-055",
    colors: ["Gold", "Silver"],
    description:
      "A twisted-rope bracelet in tarnish-resistant plated steel with a secure clasp. Subtle enough for every day.",
    media: gallery("Rope Bracelet", "gold"),
    name: "Rope Bracelet",
    price: "89.00",
    sizes: ["One Size"],
    slug: "rope-bracelet",
  },
];

export const fashionStore: StoreConfig = {
  categories: [
    { key: "women", label: "Women" },
    { key: "men", label: "Men" },
    { key: "kids", label: "Kids" },
    { key: "abayas", label: "Abayas" },
    { key: "shoes", label: "Shoes" },
    { key: "bags", label: "Bags" },
    { key: "accessories", label: "Accessories" },
  ],
  delivery: { chargeAed: "20.00", freeOverAed: "400.00" },
  products,
  profile: {
    category: "Fashion",
    description:
      "Contemporary modest fashion for the whole family — abayas, dresses, menswear and accessories, curated in Dubai and delivered across the UAE.",
    hours: [
      { days: "Saturday – Thursday", time: "9:00 AM – 10:00 PM" },
      { days: "Friday", time: "2:00 PM – 10:00 PM" },
    ],
    location: "Dubai, United Arab Emirates",
    logoInitial: "ن",
    mobile: "+971 50 123 4567",
    name: "Al Noor Fashion",
    paymentMethod: "Cash on Delivery",
    policies: {
      delivery:
        "Delivery across all seven Emirates within 1–3 working days. AED 20 delivery charge; free delivery on orders over AED 400.",
      returns:
        "Exchange or return within 7 days of delivery. Items must be unworn with original tags. Contact us on WhatsApp to arrange a pickup.",
    },
    slug: "al-noor-fashion",
    whatsapp: "+971 50 123 4567",
  },
  templateKey: "fashion",
  themeKey: "luxury-minimal",
};
