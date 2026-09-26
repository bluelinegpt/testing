import { gallery, image, video } from "./media.js";
import type { StoreConfig, StorefrontProduct } from "../types.js";

/**
 * Static sample Trader — Layali Jewelry (Jewelry template, Luxury Minimal).
 * PROTOTYPE DATA ONLY.
 */

const products: readonly StorefrontProduct[] = [
  {
    attributes: [
      { label: "Material", value: "18k yellow gold" },
      { label: "Stone", value: "0.45 ct round brilliant diamond" },
      { label: "Purity", value: "18k (750)" },
      { label: "Weight", value: "3.8 g" },
      { label: "Certificate", value: "IGI certificate included" },
      { label: "Engraving", value: "Complimentary inside-band engraving" },
    ],
    available: true,
    badges: ["featured", "best_seller"],
    category: "rings",
    code: "LJ-RG-001",
    colors: ["Yellow Gold", "White Gold"],
    description:
      "A classic solitaire ring in 18k gold with a certified 0.45 ct round brilliant diamond, hand-set in a six-claw crown.",
    media: [
      ...gallery("Solitaire Diamond Ring", "gold"),
      image("Solitaire Diamond Ring — stone close-up", "gold-5"),
      image("Solitaire Diamond Ring — certificate", "gold-6"),
      video("Solitaire Diamond Ring — sparkle", "gold"),
    ],
    name: "Solitaire Diamond Ring",
    optionLabel: "Ring Size",
    previousPrice: "5200.00",
    price: "4650.00",
    sizes: ["50", "52", "54", "56"],
    slug: "solitaire-diamond-ring",
  },
  {
    attributes: [
      { label: "Material", value: "18k rose gold" },
      { label: "Stone", value: "Freshwater pearls, AAA" },
      { label: "Purity", value: "18k (750)" },
      { label: "Length", value: "45 cm with 5 cm extender" },
      { label: "Certificate", value: "Store authenticity certificate" },
    ],
    available: true,
    badges: ["new_arrival"],
    category: "necklaces",
    code: "LJ-NK-014",
    colors: ["Rose Gold"],
    description:
      "A delicate rose-gold chain carrying a line of AAA freshwater pearls — quiet, luminous, everyday luxury.",
    media: gallery("Pearl Line Necklace", "blush"),
    name: "Pearl Line Necklace",
    price: "1890.00",
    sizes: ["One Size"],
    slug: "pearl-line-necklace",
  },
  {
    attributes: [
      { label: "Material", value: "21k yellow gold" },
      { label: "Purity", value: "21k (875)" },
      { label: "Weight", value: "12.4 g" },
      { label: "Certificate", value: "Dubai assay hallmark" },
      { label: "Engraving", value: "Available on request" },
    ],
    available: true,
    badges: ["best_seller"],
    category: "bracelets",
    code: "LJ-BR-021",
    colors: ["Yellow Gold"],
    description:
      "A traditional 21k gold bangle with a hand-finished rope edge, hallmarked in Dubai.",
    media: gallery("Gold Rope Bangle", "amber"),
    name: "Gold Rope Bangle",
    price: "3450.00",
    optionLabel: "Bangle Size",
    sizes: ["S", "M", "L"],
    slug: "gold-rope-bangle",
  },
  {
    attributes: [
      { label: "Material", value: "18k white gold" },
      { label: "Stone", value: "Blue sapphire with diamond halo" },
      { label: "Purity", value: "18k (750)" },
      { label: "Certificate", value: "IGI certificate included" },
    ],
    available: true,
    badges: ["featured"],
    category: "earrings",
    code: "LJ-ER-033",
    colors: ["White Gold"],
    description:
      "Sapphire drop earrings framed in a fine diamond halo — an evening piece with a certificate to match.",
    media: gallery("Sapphire Drop Earrings", "sky"),
    name: "Sapphire Drop Earrings",
    price: "2980.00",
    sizes: ["One Size"],
    slug: "sapphire-drop-earrings",
  },
  {
    attributes: [
      { label: "Material", value: "Stainless steel, sapphire glass" },
      { label: "Movement", value: "Swiss quartz" },
      { label: "Water Resistance", value: "5 ATM" },
      { label: "Warranty", value: "24-month movement warranty" },
    ],
    available: true,
    badges: [],
    category: "watches",
    code: "LJ-WT-041",
    colors: ["Silver / White", "Gold / Champagne"],
    description:
      "A slim dress watch with a Swiss quartz movement, sapphire glass and an easy-adjust mesh strap.",
    media: gallery("Classic Dress Watch", "cloud"),
    name: "Classic Dress Watch",
    price: "1150.00",
    sizes: ["One Size"],
    slug: "classic-dress-watch",
  },
  {
    attributes: [
      { label: "Material", value: "925 sterling silver, gold plated" },
      { label: "Contents", value: "Necklace, bracelet and earrings" },
      { label: "Certificate", value: "Store authenticity certificate" },
      { label: "Engraving", value: "Gift message card included" },
    ],
    available: false,
    badges: ["new_arrival"],
    category: "gifts",
    code: "LJ-GS-052",
    colors: ["Gold Plated"],
    description:
      "A ready-to-gift matching set in gold-plated sterling silver, boxed with a personalised message card.",
    media: gallery("Celebration Gift Set", "rose"),
    name: "Celebration Gift Set",
    price: "790.00",
    sizes: ["One Size"],
    slug: "celebration-gift-set",
  },
];

export const jewelryStore: StoreConfig = {
  categories: [
    { key: "rings", label: "Rings" },
    { key: "necklaces", label: "Necklaces" },
    { key: "bracelets", label: "Bracelets" },
    { key: "earrings", label: "Earrings" },
    { key: "watches", label: "Watches" },
    { key: "gifts", label: "Gift Sets" },
  ],
  delivery: { chargeAed: "30.00", freeOverAed: "2000.00" },
  products,
  profile: {
    category: "Jewelry",
    description:
      "Fine gold and diamond jewellery, hallmarked and certified — crafted pieces for engagements, gifts and every day, delivered securely across the UAE.",
    hours: [
      { days: "Saturday – Thursday", time: "10:00 AM – 10:00 PM" },
      { days: "Friday", time: "4:00 PM – 10:00 PM" },
    ],
    location: "Abu Dhabi, United Arab Emirates",
    logoInitial: "L",
    mobile: "+971 52 456 7890",
    name: "Layali Jewelry",
    paymentMethod: "Cash on Delivery",
    policies: {
      delivery:
        "Insured delivery across all seven Emirates within 2–3 working days. AED 30 delivery charge; free insured delivery on orders over AED 2,000.",
      returns:
        "Exchange within 7 days with the certificate and original packaging. Engraved pieces are exchange-only for sizing.",
    },
    slug: "layali-jewelry",
    whatsapp: "+971 52 456 7890",
  },
  templateKey: "jewelry",
  themeKey: "luxury-minimal",
};
