// Pricing plan copy for the public /pricing page. Values (price, period, order
// volume) are the approved commercial source of truth and must not change here
// without a business-approved update. Capability bullets describe the
// Delivery Operating System, Trader Portal, Mobile App and Company Website
// product areas (see Documentation for the approved product/pricing brief).
//
// There is no subscription-tier entitlement enforcement in the product today
// (see company-host-resolver / operations / payroll — nothing gates a feature
// by "plan"). Capability bullets below are therefore commercial positioning by
// monthly order volume, not a technical feature lock.
//
// The Free plan has exactly two approved commercial rules — do not add more
// without explicit business sign-off:
//   Included: Core Orders & Driver Management, COD & Collection Visibility,
//             Basic Reports, Mobile App Access
//   Excluded: Trader Portal, Company Website
// Nothing else (Driver Reconciliation, Trader Management, Trader Settlements,
// Accounting, Payroll, WhatsApp, Commerce Integrations, ...) is confirmed as
// included or excluded from Free — so none of it is mentioned one way or the
// other in the Free plan's copy below.
//
// "AI Agent" under Company Website is an approved product capability that is
// not actually built yet (no per-company agent exists — see
// apps/api/src/platform/company-website-settings.ts). Per explicit
// product-owner instruction it is shown in copy WITHOUT an "in development"
// qualifier — that is an accepted, deliberate choice, not an oversight.
//
// There is intentionally no per-capability Starter/Growth/Business comparison
// matrix here: with no technical entitlement system, a ✓/— grid across paid
// tiers would imply feature locks that do not exist. Plan cards differentiate
// by monthly order volume and capability emphasis only.
export const pricingPlans = [
  {
    name: "Free",
    price: "AED 0",
    period: "per month",
    volume: "Up to 100 orders / month",
    volumeAr: "حتى 100 طلب / شهر",
    cta: "Request Free Access",
    ctaAr: "اطلب الوصول المجاني",
    href: "/request-demo",
    highlights: [
      "Core Orders & Driver Management",
      "COD & Collection Visibility",
      "Basic Reports",
      "Mobile App Access",
      "Arabic / English",
    ],
    highlightsAr: [
      "إدارة الطلبات والسائقين الأساسية",
      "وضوح التحصيل والدفع عند الاستلام",
      "تقارير أساسية",
      "الوصول عبر تطبيق الجوال",
      "العربية / الإنجليزية",
    ],
    note: "Trader Portal and Company Website are available from Starter.",
    noteAr: "بوابة التجار وموقع الشركة الإلكتروني متاحان بدءاً من خطة Starter.",
  },
  {
    name: "Starter",
    price: "AED 500",
    period: "per month",
    volume: "100–2,000 orders / month",
    volumeAr: "100–2,000 طلب / شهر",
    cta: "Request Demo",
    ctaAr: "اطلب عرضاً",
    href: "/request-demo",
    highlights: [
      "Full Orders & Driver Operations",
      "COD Collection & Driver Reconciliation",
      "Trader Management & Statements",
      "Trader Portal",
      "Company Website*",
      "WhatsApp",
      "Mobile App",
      "Operational Reports",
      "Arabic / English",
    ],
    highlightsAr: [
      "إدارة كاملة للطلبات وعمليات السائقين",
      "تحصيل الدفع عند الاستلام وتسوية حسابات السائقين",
      "إدارة التجار وكشوفات الحساب",
      "بوابة التجار",
      "موقع الشركة الإلكتروني*",
      "واتساب",
      "تطبيق الجوال",
      "تقارير تشغيلية",
      "العربية / الإنجليزية",
    ],
    note: "",
    noteAr: "",
  },
  {
    name: "Growth",
    price: "AED 1000",
    period: "per month",
    volume: "2,001–5,000 orders / month",
    volumeAr: "2,001–5,000 طلب / شهر",
    cta: "Request Demo",
    ctaAr: "اطلب عرضاً",
    href: "/request-demo",
    highlights: [
      "Everything in Starter",
      "Trader Settlements",
      "Accounting",
      "Payroll & Driver Earnings",
      "Advanced Reports",
      "Trader Portal + Commerce Integrations",
      "Company Website + AI Agent*",
      "Mobile App",
      "Arabic / English",
    ],
    highlightsAr: [
      "كل ما في خطة Starter",
      "تسويات التجار",
      "المحاسبة",
      "الرواتب واستحقاقات السائقين",
      "تقارير متقدمة",
      "بوابة التجار + تكاملات التجارة",
      "موقع الشركة الإلكتروني + مساعد ذكي*",
      "تطبيق الجوال",
      "العربية / الإنجليزية",
    ],
    note: "",
    noteAr: "",
  },
  {
    name: "Business",
    price: "AED 2000",
    period: "per month",
    volume: "5,001–10,000 orders / month",
    volumeAr: "5,001–10,000 طلب / شهر",
    cta: "Request Demo",
    ctaAr: "اطلب عرضاً",
    href: "/request-demo",
    highlights: [
      "Full Delivery Operating System",
      "Advanced Accounting & Financial Control",
      "Payroll & Driver Earnings",
      "Trader Settlement Management",
      "Management & Performance Reports",
      "Trader Portal + Integrations",
      "Branded Company Website*",
      "WhatsApp + AI Agent",
      "Mobile App",
      "Arabic / English",
      "Higher-volume operational support",
    ],
    highlightsAr: [
      "نظام تشغيل توصيل متكامل",
      "محاسبة متقدمة وتحكم مالي",
      "الرواتب واستحقاقات السائقين",
      "إدارة تسويات التجار",
      "تقارير الإدارة والأداء",
      "بوابة التجار + التكاملات",
      "موقع إلكتروني للشركة بهوية خاصة*",
      "واتساب + مساعد ذكي",
      "تطبيق الجوال",
      "العربية / الإنجليزية",
      "دعم تشغيلي للحجم الأعلى",
    ],
    note: "",
    noteAr: "",
  },
] as const;

export const pricingGapNote =
  "For more than 10,000 monthly orders, Tawseelhub can confirm a custom commercial tier.";

// Marks every "Company Website" highlight above (Starter onward) with a
// trailing "*" -- this is its footnote. No specific add-on price is quoted
// here per explicit product-owner instruction; keep this general until a
// figure is approved.
export const pricingWebsiteAddOnNote = "* Company Website is available at an additional cost.";

// The four customer-facing product areas the pricing page must communicate,
// each with a concise, non-exhaustive capability summary.
export const pricingProductAreas = [
  {
    key: "operating_system",
    name: "Delivery Operating System",
    nameAr: "نظام تشغيل التوصيل",
    items: [
      "Orders",
      "Drivers",
      "COD",
      "Driver Reconciliation",
      "Trader Settlements",
      "Accounting",
      "Payroll",
      "Reports",
    ],
    itemsAr: [
      "الطلبات",
      "السائقون",
      "الدفع عند الاستلام",
      "تسوية حسابات السائقين",
      "تسويات التجار",
      "المحاسبة",
      "الرواتب",
      "التقارير",
    ],
  },
  {
    key: "trader_portal",
    name: "Trader Portal",
    nameAr: "بوابة التجار",
    items: [
      "Trader Orders & History",
      "Statements",
      "Settlement Visibility",
      "Delivery Company Relationships",
      "Commerce Integrations",
    ],
    itemsAr: [
      "طلبات التاجر وسجله",
      "كشوفات الحساب",
      "وضوح التسويات",
      "علاقات شركة التوصيل",
      "تكاملات التجارة",
    ],
  },
  {
    key: "mobile_app",
    name: "Mobile App",
    nameAr: "تطبيق الجوال",
    items: [
      "Assigned Orders",
      "Delivery Status Updates",
      "Driver Operations",
      "Arabic / English",
      "Connected to the same Tawseelhub backend",
    ],
    itemsAr: [
      "الطلبات المسندة",
      "تحديثات حالة التوصيل",
      "عمليات السائقين",
      "العربية / الإنجليزية",
      "متصل بنفس نظام Tawseelhub",
    ],
  },
  {
    key: "company_website",
    name: "Company Website",
    nameAr: "موقع الشركة الإلكتروني",
    items: [
      "Company Website",
      "Company Logo / Branding",
      "Custom Company Information",
      "WhatsApp",
      "AI Agent",
      "Website Enable / Disable",
      "Contact / business information",
    ],
    itemsAr: [
      "موقع إلكتروني للشركة",
      "شعار الشركة / الهوية البصرية",
      "معلومات مخصصة للشركة",
      "واتساب",
      "مساعد ذكي",
      "تفعيل / تعطيل الموقع",
      "معلومات التواصل والنشاط التجاري",
    ],
  },
] as const;
