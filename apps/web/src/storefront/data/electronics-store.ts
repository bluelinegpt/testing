import { gallery, image, video } from "./media.js";
import type { StoreConfig, StorefrontProduct } from "../types.js";

/**
 * Static sample Trader — Tech Horizon (Electronics template, Modern theme).
 * PROTOTYPE DATA ONLY.
 */

const products: readonly StorefrontProduct[] = [
  {
    attributes: [
      { label: "Brand", value: "Nova" },
      { label: "Model", value: "Nova X2 Pro" },
      { label: "Display", value: '6.7" AMOLED, 120 Hz' },
      { label: "Storage", value: "256 GB / 512 GB" },
      { label: "Camera", value: "50 MP triple system" },
      { label: "Battery", value: "5,000 mAh, 65 W fast charge" },
      { label: "Condition", value: "New, UAE version" },
      { label: "Warranty", value: "24-month UAE warranty" },
    ],
    available: true,
    badges: ["featured", "best_seller"],
    category: "phones",
    code: "TH-PH-101",
    colors: ["Graphite", "Arctic Silver"],
    description:
      "A flagship-grade smartphone with a 120 Hz AMOLED display, all-day battery and a 50 MP camera system — the UAE version with full local warranty.",
    media: [
      ...gallery("Nova X2 Pro", "slate"),
      image("Nova X2 Pro — camera module", "slate-5"),
      video("Nova X2 Pro — display and design", "slate"),
    ],
    name: "Nova X2 Pro Smartphone",
    optionLabel: "Storage",
    previousPrice: "2499.00",
    price: "2199.00",
    sizes: ["256 GB", "512 GB"],
    slug: "nova-x2-pro",
  },
  {
    attributes: [
      { label: "Brand", value: "Aeris" },
      { label: "Model", value: "AerisBook 14" },
      { label: "Processor", value: "8-core, 4.8 GHz boost" },
      { label: "Memory", value: "16 GB" },
      { label: "Storage", value: "512 GB / 1 TB SSD" },
      { label: "Weight", value: "1.29 kg" },
      { label: "Warranty", value: "12-month UAE warranty" },
    ],
    available: true,
    badges: ["new_arrival"],
    category: "laptops",
    code: "TH-LT-210",
    colors: ["Space Grey"],
    description:
      "A thin-and-light 14-inch laptop for work and study: fast SSD storage, a bright anti-glare display and quiet cooling.",
    media: gallery("AerisBook 14", "navy"),
    name: "AerisBook 14 Laptop",
    optionLabel: "Storage",
    price: "3499.00",
    sizes: ["512 GB", "1 TB"],
    slug: "aerisbook-14",
  },
  {
    attributes: [
      { label: "Brand", value: "Pulse" },
      { label: "Type", value: "Over-ear, wireless" },
      { label: "Playtime", value: "40 hours" },
      { label: "Noise Cancelling", value: "Active, hybrid" },
      { label: "Warranty", value: "12-month UAE warranty" },
    ],
    available: true,
    badges: ["best_seller"],
    category: "audio",
    code: "TH-AU-305",
    colors: ["Black", "Sand"],
    description:
      "Wireless over-ear headphones with hybrid active noise cancelling and a 40-hour battery — made for flights, commutes and focus.",
    media: gallery("Pulse Over-Ear Headphones", "noir"),
    name: "Pulse ANC Headphones",
    price: "449.00",
    previousPrice: "549.00",
    sizes: ["One Size"],
    slug: "pulse-anc-headphones",
  },
  {
    attributes: [
      { label: "Brand", value: "Nova" },
      { label: "Capacity", value: "20,000 mAh" },
      { label: "Output", value: "65 W USB-C" },
      { label: "Ports", value: "2× USB-C, 1× USB-A" },
      { label: "Warranty", value: "6-month warranty" },
    ],
    available: true,
    badges: [],
    category: "accessories",
    code: "TH-AC-410",
    colors: ["Black"],
    description:
      "A 20,000 mAh power bank that fast-charges phones and laptops alike through 65 W USB-C.",
    media: gallery("Nova Power Bank", "gold"),
    name: "Nova 65W Power Bank",
    price: "179.00",
    sizes: ["One Size"],
    slug: "nova-power-bank",
  },
  {
    attributes: [
      { label: "Brand", value: "HomeSense" },
      { label: "Type", value: "Smart plug, Wi-Fi" },
      { label: "Load", value: "16 A max" },
      { label: "Works With", value: "Voice assistants and app schedules" },
      { label: "Warranty", value: "12-month warranty" },
    ],
    available: true,
    badges: ["new_arrival"],
    category: "smart",
    code: "TH-SM-502",
    colors: ["White"],
    description:
      "A compact Wi-Fi smart plug with scheduling, energy monitoring and voice-assistant support.",
    media: gallery("HomeSense Smart Plug", "cloud"),
    name: "HomeSense Smart Plug (2-Pack)",
    price: "129.00",
    sizes: ["2-Pack"],
    slug: "homesense-smart-plug",
  },
  {
    attributes: [
      { label: "Brand", value: "Pulse" },
      { label: "Type", value: "True wireless earbuds" },
      { label: "Playtime", value: "30 hours with case" },
      { label: "Water Resistance", value: "IPX5" },
      { label: "Warranty", value: "12-month UAE warranty" },
    ],
    available: false,
    badges: [],
    category: "audio",
    code: "TH-AU-320",
    colors: ["White", "Black"],
    description:
      "Compact true-wireless earbuds with deep bass, clear calls and an IPX5 splash-proof build.",
    media: gallery("Pulse Buds", "sky"),
    name: "Pulse Buds Mini",
    price: "199.00",
    sizes: ["One Size"],
    slug: "pulse-buds-mini",
  },
];

export const electronicsStore: StoreConfig = {
  categories: [
    { key: "phones", label: "Mobile Phones" },
    { key: "laptops", label: "Laptops" },
    { key: "accessories", label: "Accessories" },
    { key: "audio", label: "Audio" },
    { key: "smart", label: "Smart Devices" },
  ],
  delivery: { chargeAed: "15.00", freeOverAed: "300.00" },
  products,
  profile: {
    category: "Electronics",
    description:
      "Genuine consumer electronics with UAE warranty — phones, laptops, audio and smart devices, delivered fast across the Emirates.",
    hours: [
      { days: "Saturday – Thursday", time: "10:00 AM – 11:00 PM" },
      { days: "Friday", time: "2:00 PM – 11:00 PM" },
    ],
    location: "Sharjah, United Arab Emirates",
    logoInitial: "T",
    mobile: "+971 55 987 6543",
    name: "Tech Horizon",
    paymentMethod: "Cash on Delivery",
    policies: {
      delivery:
        "Delivery across all seven Emirates within 1–2 working days. AED 15 delivery charge; free delivery on orders over AED 300.",
      returns:
        "7-day return for unopened items in original packaging; warranty service for everything else through the brand's UAE service centres.",
    },
    slug: "tech-horizon",
    whatsapp: "+971 55 987 6543",
  },
  templateKey: "electronics",
  themeKey: "modern",
};
