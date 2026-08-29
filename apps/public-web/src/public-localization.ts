import { useEffect, useState } from "react";
import type { Locale } from "./website-cms-client";

export type PublicLocale = Locale;

export const publicLocaleStorageKey = "tawseelhub.locale";
export const publicLocaleChangeEvent = "tawseelhub:locale-changed";

export function getStoredPublicLocale(): PublicLocale {
  if (typeof window === "undefined") return "en";
  return window.localStorage.getItem(publicLocaleStorageKey) === "ar" ? "ar" : "en";
}

export function savePublicLocale(locale: PublicLocale): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(publicLocaleStorageKey, locale);
  window.dispatchEvent(new CustomEvent(publicLocaleChangeEvent, { detail: { locale } }));
}

export function usePublicLocale(): PublicLocale {
  const [locale, setLocale] = useState<PublicLocale>(() => getStoredPublicLocale());
  useEffect(() => {
    const update = () => setLocale(getStoredPublicLocale());
    window.addEventListener("storage", update);
    window.addEventListener(publicLocaleChangeEvent, update);
    return () => {
      window.removeEventListener("storage", update);
      window.removeEventListener(publicLocaleChangeEvent, update);
    };
  }, []);
  return locale;
}

export const routeMetadata: Record<
  PublicLocale,
  Record<string, { title: string; description: string }>
> = {
  en: {
    "/": {
      title: "Delivery Operating System for Delivery Companies | Tawseelhub",
      description:
        "Tawseelhub is delivery management software that connects Orders, Drivers, COD collections, Trader settlements, accounting and payroll in one platform — built for UAE delivery companies.",
    },
    "/delivery-companies": {
      title: "Delivery Management Software UAE | Tawseelhub Delivery Operating System",
      description:
        "Tawseelhub is a Delivery Operating System for UAE delivery companies, combining orders, drivers, COD collections, Trader settlements, accounting, payroll and reporting.",
    },
    "/send-a-package": {
      title: "Send a Package | UAE & International Delivery Quotes",
      description:
        "Request a UAE domestic or international delivery quotation with pickup, destination, package and contact details in one form.",
    },
    "/traders": {
      title: "Delivery Solutions for Traders & Online Sellers UAE | Tawseelhub",
      description:
        "Register your business with Tawseelhub, connect your existing Delivery Company or let us help you find a suitable delivery partner for Salla, Shopify, WooCommerce and other sales channels.",
    },
    "/traders/register": {
      title: "Trader Registration | Tawseelhub",
      description:
        "Apply to register your UAE business with Tawseelhub and prepare a verified delivery relationship.",
    },
    "/integrations": {
      title: "Commerce Integrations",
      description:
        "Prepare to connect Salla, Shopify and WooCommerce orders to delivery operations through planned Tawseelhub integrations.",
    },
    "/resources": {
      title: "Tawseelhub Help Center | Guides & Resources",
      description:
        "Search Tawseelhub Help Center guides for orders, drivers, COD collections, Trader statements, reports, integrations and support.",
    },
    "/blog": {
      title: "Tawseelhub Insights",
      description:
        "Insights for delivery companies and Traders building more connected delivery operations in the UAE.",
    },
    "/pricing": {
      title: "Tawseelhub Pricing | AED Plans for Delivery Companies",
      description:
        "Review Tawseelhub pricing in AED, from a free tier up to high-volume delivery operations. Request a demo for the right plan.",
    },
    "/about": {
      title: "About Tawseelhub",
      description:
        "Learn why Tawseelhub is building a connected delivery operating system for delivery businesses in the UAE.",
    },
    "/contact": {
      title: "Contact Tawseelhub",
      description:
        "Contact the Tawseelhub team about delivery operations, partnerships and the platform.",
    },
    "/privacy": {
      title: "Privacy Policy | Tawseelhub",
      description: "How Tawseelhub handles personal data across the public website and platform.",
    },
    "/terms": {
      title: "Terms of Service | Tawseelhub",
      description: "Terms governing use of the Tawseelhub website and platform.",
    },
    "/request-demo": {
      title: "Request a Tawseelhub Demo",
      description: "Request a tailored international Tawseelhub demo for your delivery company.",
    },
    "/track": {
      title: "Track Your Shipment | Tawseelhub",
      description:
        "Track your shipment securely using your Airway Bill and view the latest delivery status.",
    },
  },
  ar: {
    "/": {
      title: "نظام تشغيل التوصيل لشركات التوصيل في الإمارات | Tawseelhub",
      description:
        "أدر الطلبات والسائقين والتحصيل عند الاستلام وتسويات التجار والمحاسبة والرواتب مع Tawseelhub، نظام إدارة التوصيل المصمم للإمارات.",
    },
    "/delivery-companies": {
      title: "برنامج إدارة التوصيل في الإمارات | Tawseelhub",
      description:
        "Tawseelhub هو نظام تشغيل التوصيل لشركات التوصيل في الإمارات، يجمع الطلبات والسائقين والتحصيل وتسويات التجار والمحاسبة والرواتب والتقارير.",
    },
    "/send-a-package": {
      title: "أرسل شحنة | عروض توصيل داخل الإمارات وخارجها",
      description:
        "اطلب عرض توصيل لشحنة داخل الإمارات أو دولياً من خلال نموذج واحد يجمع بيانات الاستلام والتوصيل والشحنة والتواصل.",
    },
    "/traders": {
      title: "حلول التوصيل للتجار والمتاجر الإلكترونية | Tawseelhub",
      description:
        "سجل نشاطك التجاري مع Tawseelhub واربط علاقة التوصيل الحالية أو دعنا نساعدك في إيجاد شريك توصيل مناسب.",
    },
    "/traders/register": {
      title: "تسجيل تاجر | Tawseelhub",
      description:
        "قدم طلب تسجيل نشاطك التجاري في الإمارات مع Tawseelhub للتحضير لعلاقة توصيل موثقة.",
    },
    "/integrations": {
      title: "تكاملات التجارة | Tawseelhub",
      description:
        "استعد لربط طلبات Salla وShopify وWooCommerce بعمليات التوصيل من خلال تكاملات Tawseelhub المخطط لها.",
    },
    "/resources": {
      title: "مركز مساعدة Tawseelhub | أدلة وموارد",
      description:
        "ابحث في أدلة Tawseelhub للطلبات والسائقين والتحصيل عند الاستلام وتسويات التجار والتقارير والتكاملات والدعم.",
    },
    "/blog": {
      title: "مدونة Tawseelhub",
      description: "رؤى عملية لشركات التوصيل والتجار لبناء عمليات توصيل أكثر ترابطاً في الإمارات.",
    },
    "/pricing": {
      title: "أسعار Tawseelhub | خطط شهرية بالدرهم",
      description:
        "راجع أسعار Tawseelhub بالدرهم، من الخطة المجانية إلى خطط عمليات التوصيل عالية الحجم.",
    },
    "/about": {
      title: "عن Tawseelhub",
      description:
        "تعرف على سبب بناء Tawseelhub لنظام تشغيل توصيل مترابط لشركات التوصيل في الإمارات.",
    },
    "/contact": {
      title: "تواصل مع Tawseelhub",
      description: "تواصل مع فريق Tawseelhub بخصوص عمليات التوصيل والشراكات والمنصة.",
    },
    "/privacy": {
      title: "سياسة الخصوصية | Tawseelhub",
      description: "كيف يتعامل Tawseelhub مع البيانات الشخصية عبر الموقع العام والمنصة.",
    },
    "/terms": {
      title: "شروط الخدمة | Tawseelhub",
      description: "شروط استخدام موقع ومنصة Tawseelhub.",
    },
    "/request-demo": {
      title: "اطلب عرض Tawseelhub",
      description: "اطلب عرضاً مخصصاً من Tawseelhub لشركة التوصيل لديك.",
    },
    "/track": {
      title: "تتبع شحنتك | Tawseelhub",
      description: "تتبع شحنتك بأمان باستخدام رقم بوليصة الشحن واطّلع على آخر حالة توصيل.",
    },
  },
};

export const publicUi = {
  en: {
    requestDemo: "Request Demo",
    languageToggle: "AR",
    mobileLanguage: "العربية",
    skipToContent: "Skip to content",
    mainNavigation: "Main navigation",
    mobileNavigation: "Mobile navigation",
    openNavigation: "Open navigation",
    footerReady: "English · العربية ready",
    talk: "Talk to Us",
    fullPricing: "View Full Pricing",
    plan: "Plan",
    common: "Most common",
    pricingEyebrow: "Pricing",
    pricingTitle: "One Complete Delivery Operating System",
    pricingCopy: "Plans based on monthly order volume.",
    pricingIntro:
      "Choose the plan that matches your delivery volume while keeping the core Tawseelhub operating experience clear and connected.",
    pricingPlanBadge: "Plan",
    pricingCapabilitiesEyebrow: "What every plan connects to",
    pricingCapabilitiesTitle: "Included Product Capabilities",
    pricingCapabilitiesCopy:
      "Every Tawseelhub subscription connects the same four product areas — plans differ by monthly order volume, not by locking away capability.",
    companyWebsiteExplanation:
      "Each eligible Delivery Company can have its own customer-facing website connected to Tawseelhub, with its own branding, company information, WhatsApp contact and AI-assisted customer interaction.",
    pricingHierarchyRoot: "Tawseelhub Subscription",
    contactTitle: "Let’s talk about your delivery operation.",
    contactCopy: "Contact Tawseelhub or request a tailored product demonstration.",
    directContact: "Direct contact",
    productEnquiries: "Product enquiries",
    demoContext: "See Tawseelhub in context.",
    demoContextCopy:
      "Share your delivery model, team shape and operational priorities during the demo process.",
    pageNotFound: "Page not found",
    routeUnavailable: "This route isn’t available.",
    returnHome: "Back to homepage",
    deliveryOperatingSystem: "Delivery Operating System",
    trackingNavLabel: "Track Shipment",
    trackingEyebrow: "Tracking",
    trackingPageTitle: "Track Your Shipment",
    trackingPageIntro:
      "Enter your Airway Bill or Tawseelhub Order Number to see the latest delivery status.",
    trackingHomepageEyebrow: "Already have a shipment?",
    trackingHomepageTitle: "Track a Shipment",
    trackingHomepageCopy: "Enter your Airway Bill or Tawseelhub Order Number.",
    trackingInputLabel: "Airway Bill or Tawseelhub Order Number",
    trackingInputPlaceholder: "X123456 or ORD-000116",
    trackingSubmitCta: "Track Shipment",
    trackingChecking: "Checking…",
    trackingVerifyTitle: "Additional verification required",
    trackingVerifyIntro: "Please enter the customer mobile number associated with this shipment.",
    trackingMobileLabel: "Customer Mobile Number",
    trackingMobilePlaceholder: "e.g. 0501234567",
    trackingVerifyCta: "Verify & Track",
    trackingNotFound:
      "We couldn't find a shipment with that Airway Bill or Order Number. Please check the number and try again.",
    trackingNotVerified: "We couldn't verify a shipment with those details.",
    trackingSupport:
      "We couldn't uniquely verify this shipment. Please contact the Tawseelhub Team for assistance.",
    trackingContactSupport: "Contact Tawseelhub Team",
    trackingErrorGeneric: "Something went wrong. Please try again.",
    trackingAirwayBillLabel: "Airway Bill / Order Number",
    trackingStatusLabel: "Status",
    trackingLastUpdatedLabel: "Last Updated",
    trackingDeliveredAtLabel: "Delivered At",
    trackingTimelineTitle: "Shipment Timeline",
    trackingTrackAnother: "Track another shipment",
    trackingPrivacyNote: "Your information is used only to verify and display shipment status.",
    trackingBack: "Back",
  },
  ar: {
    requestDemo: "اطلب عرضاً",
    languageToggle: "EN",
    mobileLanguage: "English",
    skipToContent: "تجاوز إلى المحتوى",
    mainNavigation: "التنقل الرئيسي",
    mobileNavigation: "تنقل الهاتف",
    openNavigation: "فتح القائمة",
    footerReady: "جاهز بالعربية والإنجليزية",
    talk: "تواصل معنا",
    fullPricing: "عرض الأسعار كاملة",
    plan: "الخطة",
    common: "الأكثر استخداماً",
    pricingEyebrow: "الأسعار",
    pricingTitle: "نظام تشغيل توصيل متكامل واحد",
    pricingCopy: "خطط حسب حجم الطلبات الشهري.",
    pricingIntro:
      "اختر الخطة المناسبة لحجم التوصيل لديك مع الحفاظ على تجربة تشغيل Tawseelhub واضحة ومترابطة.",
    pricingPlanBadge: "الخطة",
    pricingCapabilitiesEyebrow: "ما يتصل به كل اشتراك",
    pricingCapabilitiesTitle: "مزايا المنتج المشمولة",
    pricingCapabilitiesCopy:
      "يربط كل اشتراك في Tawseelhub نفس مجالات المنتج الأربعة — تختلف الخطط بحجم الطلبات الشهري، وليس بإخفاء الإمكانيات.",
    companyWebsiteExplanation:
      "يمكن لكل شركة توصيل مؤهلة امتلاك موقعها الإلكتروني الخاص المتصل بـ Tawseelhub، بهويته البصرية ومعلومات الشركة والتواصل عبر واتساب والتفاعل المدعوم بالذكاء الاصطناعي مع العملاء.",
    pricingHierarchyRoot: "اشتراك Tawseelhub",
    contactTitle: "لنتحدث عن عمليات التوصيل لديك.",
    contactCopy: "تواصل مع Tawseelhub أو اطلب عرضاً مناسباً لشركتك.",
    directContact: "تواصل مباشر",
    productEnquiries: "استفسارات المنتج",
    demoContext: "شاهد Tawseelhub حسب وضع شركتك.",
    demoContextCopy: "شارك نموذج التوصيل وحجم الفريق وأولويات التشغيل خلال العرض.",
    pageNotFound: "الصفحة غير موجودة",
    routeUnavailable: "هذا المسار غير متاح.",
    returnHome: "العودة إلى الصفحة الرئيسية",
    deliveryOperatingSystem: "نظام تشغيل التوصيل",
    trackingNavLabel: "تتبع الشحنة",
    trackingEyebrow: "تتبع",
    trackingPageTitle: "تتبع شحنتك",
    trackingPageIntro: "أدخل رقم بوليصة الشحن أو رقم طلب Tawseelhub لمعرفة آخر حالة للتوصيل.",
    trackingHomepageEyebrow: "لديك شحنة بالفعل؟",
    trackingHomepageTitle: "تتبع شحنة",
    trackingHomepageCopy: "أدخل رقم بوليصة الشحن أو رقم طلب Tawseelhub.",
    trackingInputLabel: "رقم بوليصة الشحن أو رقم طلب Tawseelhub",
    trackingInputPlaceholder: "X123456 أو ORD-000116",
    trackingSubmitCta: "تتبع الشحنة",
    trackingChecking: "جارٍ التحقق…",
    trackingVerifyTitle: "يلزم تحقق إضافي",
    trackingVerifyIntro: "الرجاء إدخال رقم هاتف العميل المرتبط بهذه الشحنة.",
    trackingMobileLabel: "رقم هاتف العميل",
    trackingMobilePlaceholder: "مثال: 0501234567",
    trackingVerifyCta: "تحقق وتتبع",
    trackingNotFound:
      "لم نعثر على شحنة بهذا الرقم. الرجاء التحقق من رقم بوليصة الشحن أو رقم طلب Tawseelhub والمحاولة مرة أخرى.",
    trackingNotVerified: "لم نتمكن من التحقق من شحنة بهذه البيانات.",
    trackingSupport:
      "تعذّر التحقق من هذه الشحنة بشكل فريد. الرجاء التواصل مع فريق Tawseelhub للمساعدة.",
    trackingContactSupport: "تواصل مع فريق Tawseelhub",
    trackingErrorGeneric: "حدث خطأ ما. الرجاء المحاولة مرة أخرى.",
    trackingAirwayBillLabel: "رقم بوليصة الشحن / رقم الطلب",
    trackingStatusLabel: "الحالة",
    trackingLastUpdatedLabel: "آخر تحديث",
    trackingDeliveredAtLabel: "تم التسليم في",
    trackingTimelineTitle: "مسار الشحنة",
    trackingTrackAnother: "تتبع شحنة أخرى",
    trackingPrivacyNote: "تُستخدم معلوماتك فقط للتحقق من حالة الشحنة وعرضها.",
    trackingBack: "رجوع",
  },
} as const;

export const navItemsByLocale = {
  en: [
    ["/delivery-companies", "Solutions"],
    ["/send-a-package", "Send a Package"],
    ["/track", "Track Shipment"],
    ["/traders", "Store"],
    ["/pricing", "Pricing"],
    ["/resources", "Help"],
    ["/blog", "Blog"],
  ],
  ar: [
    ["/delivery-companies", "الحلول"],
    ["/send-a-package", "أرسل شحنة"],
    ["/track", "تتبع الشحنة"],
    ["/traders", "المتجر"],
    ["/pricing", "الأسعار"],
    ["/resources", "المساعدة"],
    ["/blog", "المدونة"],
  ],
} as const;

export const countriesByLocale = {
  en: [
    ["AE", "United Arab Emirates"],
    ["SA", "Saudi Arabia"],
    ["OM", "Oman"],
    ["QA", "Qatar"],
    ["KW", "Kuwait"],
    ["BH", "Bahrain"],
    ["JO", "Jordan"],
    ["EG", "Egypt"],
    ["GB", "United Kingdom"],
    ["US", "United States"],
    ["IN", "India"],
    ["PK", "Pakistan"],
    ["PH", "Philippines"],
    ["TR", "Türkiye"],
    ["CN", "China"],
    ["DE", "Germany"],
    ["FR", "France"],
    ["ZZ", "Other country"],
  ],
  ar: [
    ["AE", "الإمارات العربية المتحدة"],
    ["SA", "السعودية"],
    ["OM", "عُمان"],
    ["QA", "قطر"],
    ["KW", "الكويت"],
    ["BH", "البحرين"],
    ["JO", "الأردن"],
    ["EG", "مصر"],
    ["GB", "المملكة المتحدة"],
    ["US", "الولايات المتحدة"],
    ["IN", "الهند"],
    ["PK", "باكستان"],
    ["PH", "الفلبين"],
    ["TR", "تركيا"],
    ["CN", "الصين"],
    ["DE", "ألمانيا"],
    ["FR", "فرنسا"],
    ["ZZ", "دولة أخرى"],
  ],
} as const;

export const emiratesByLocale = {
  en: [
    ["ajman", "Ajman"],
    ["dubai", "Dubai"],
    ["sharjah", "Sharjah"],
    ["abu_dhabi", "Abu Dhabi"],
    ["umm_al_quwain", "Umm Al Quwain"],
    ["ras_al_khaimah", "Ras Al Khaimah"],
    ["fujairah", "Fujairah"],
  ],
  ar: [
    ["ajman", "عجمان"],
    ["dubai", "دبي"],
    ["sharjah", "الشارقة"],
    ["abu_dhabi", "أبوظبي"],
    ["umm_al_quwain", "أم القيوين"],
    ["ras_al_khaimah", "رأس الخيمة"],
    ["fujairah", "الفجيرة"],
  ],
} as const;

export const packageTypesByLocale = {
  en: [
    ["document", "Document"],
    ["small_parcel", "Small Parcel"],
    ["medium_parcel", "Parcel"],
    ["box", "Box"],
    ["large_parcel", "Multiple Boxes"],
    ["other", "Other"],
  ],
  ar: [
    ["document", "مستندات"],
    ["small_parcel", "طرد صغير"],
    ["medium_parcel", "طرد متوسط"],
    ["box", "صندوق"],
    ["large_parcel", "عدة صناديق"],
    ["other", "أخرى"],
  ],
} as const;

export function localizedCountryName(code: string, locale: PublicLocale): string {
  return countriesByLocale[locale].find(([value]) => value === code)?.[1] ?? code;
}

export function canonicalCountryName(code: string): string {
  return countriesByLocale.en.find(([value]) => value === code)?.[1] ?? code;
}

export function localizedEmirateName(value: string | undefined, locale: PublicLocale): string {
  if (!value) return "";
  return emiratesByLocale[locale].find(([code]) => code === value)?.[1] ?? value;
}

export function localizedPackageType(value: unknown, locale: PublicLocale): string {
  const text = String(value ?? "");
  return (
    packageTypesByLocale[locale].find(([code]) => code === text)?.[1] ?? text.replace(/_/g, " ")
  );
}
