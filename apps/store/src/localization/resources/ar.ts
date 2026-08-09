/**
 * Arabic interface copy.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS TRANSLATED AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 *
 * Everything here is a SYSTEM label — text this application owns. All of it is
 * translated, because an Arabic page that leaves "Featured stores" or "Product
 * code" in English is not an Arabic page; it is an English page with the
 * columns flipped.
 *
 * Trader-entered content is the opposite case and is never touched: a Product
 * called "Dev Embroidered Abaya" stays exactly that in Arabic, because the
 * Trader has not written an Arabic name and inventing one would put words in a
 * merchant's mouth about their own goods. When per-language Trader fields
 * arrive, they get used here; machine translation does not.
 *
 * Wording follows Gulf retail convention rather than literal translation —
 * "متوفر" for in-stock, "مطلوب" for a required option, "السعر السابق" for a
 * struck-through price — because these are the words a shopper in the UAE
 * already reads on other shopping sites.
 */
export const ar = {
  categories: {
    breadcrumb: "مسار التنقل",
    browseOthers: "تصفّح فئات أخرى",
    empty: {
      body: "ستظهر الفئات هنا بمجرد إعداد السوق.",
      title: "لا توجد فئات بعد",
    },
    home: "الرئيسية",
    noProducts: {
      body: "لا توجد منتجات مدرجة في هذه الفئة بعد.",
      title: "لا توجد منتجات بعد",
    },
    noStores: {
      body: "لا توجد متاجر مدرجة في هذه الفئة بعد.",
      title: "لا توجد متاجر بعد",
    },
    notFound: {
      body: "لم نتمكن من العثور على هذه الفئة.",
      title: "الفئة غير موجودة",
    },
    productCount: "منتج واحد",
    productCount_other: "{{count}} منتجات",
    products: "المنتجات",
    stores: "المتاجر",
    subcategories: "الفئات الفرعية",
    title: "الفئات",
    viewAll: "عرض الكل",
  },
  common: {
    account: "حسابي",
    all: "الكل",
    arabic: "العربية",
    back: "رجوع",
    cart: "السلة",
    comingSoon: "قريبًا",
    english: "English",
    language: "اللغة",
    loading: "جارٍ التحميل",
    retry: "إعادة المحاولة",
    search: "بحث",
    searchPlaceholder: "ابحث عن المتاجر والمنتجات",
    skipToContent: "تخطٍ إلى المحتوى",
    viewAll: "عرض الكل",
  },
  errors: {
    apiUnavailable: {
      body: "تعذّر الوصول إلى خدمة المتجر. يرجى المحاولة بعد قليل.",
      title: "الخدمة غير متاحة",
    },
    network: {
      body: "تحقّق من الاتصال ثم أعد المحاولة.",
      title: "مشكلة في الاتصال",
    },
    productNotFound: {
      body: "لم يعد هذا المنتج مدرجًا.",
      title: "المنتج غير موجود",
    },
    storeClosed: {
      body: "هذا المتجر مغلق مؤقتًا ولا يستقبل الطلبات حاليًا.",
      title: "مغلق مؤقتًا",
    },
    storeNotFound: {
      body: "لم نتمكن من العثور على متجر على هذا العنوان.",
      title: "المتجر غير موجود",
    },
  },
  footer: {
    company: "بلولاين جي بي تي",
    customer: "للعملاء",
    legal: "الشؤون القانونية",
    privacy: "الخصوصية",
    rights: "متجر بلولاين جي بي تي",
    support: "الدعم",
    tagline: "تسوّق من المتاجر المحلية في الإمارات وادفع نقدًا عند الاستلام.",
    terms: "الشروط",
    track: "تتبّع طلبك",
  },
  home: {
    account: {
      body: "سجّل الدخول لعرض طلباتك وعناوينك المحفوظة. حسابات العملاء قادمة قريبًا.",
      title: "حسابك",
    },
    app: {
      body: "تطبيق متجر بلولاين جي بي تي في الطريق.",
      title: "تسوّق أينما كنت",
    },
    bestsellers: { title: "الأكثر مبيعًا" },
    curatedCollections: { title: "تشكيلات مختارة" },
    empty: {
      body: "لا توجد متاجر منشورة بعد. سيظهر المتجر هنا فور افتتاحه.",
      title: "لا يوجد ما نعرضه بعد",
    },
    featuredStores: {
      subtitle: "متاجر مفتوحة الآن على بلولاين جي بي تي",
      title: "متاجر مميّزة",
    },
    hero: {
      cta: "تصفّح الفئات",
      lead: "تسوّق من المتاجر المحلية في الإمارات وادفع نقدًا عند الاستلام.",
      title: "كل ما تحتاجه، من متاجر قريبة منك",
    },
    promotionalBanner: { title: "العروض" },
    quickCategories: { title: "تصفّح الفئات" },
    recommended: { title: "مقترح لك" },
    track: {
      body: "تتبّع الطلبات سيتوفّر مع حسابات العملاء.",
      title: "تتبّع طلبك",
    },
  },
  product: {
    availability: { available: "متوفر", unavailable: "غير متوفر حاليًا" },
    backToStore: "العودة إلى المتجر",
    brand: "العلامة التجارية",
    code: "رمز المنتج",
    details: "التفاصيل",
    gallery: "صور المنتج",
    imageOf: "صورة {{index}} من {{total}}",
    noImage: "لا تتوفر صورة",
    optionRequired: "مطلوب",
    options: "الخيارات",
    saveAmount: "وفّر {{amount}}",
    share: {
      action: "مشاركة",
      copied: "تم نسخ الرابط",
      unavailable: "انسخ الرابط من شريط العنوان",
    },
    soldBy: "يُباع بواسطة",
    was: "السعر السابق",
  },
  store: {
    about: "عن هذا المتجر",
    businessHours: "ساعات العمل",
    categories: "الفئات",
    closed: "مغلق مؤقتًا",
    contact: "التواصل",
    delivery: "معلومات التوصيل",
    email: "البريد الإلكتروني",
    information: "معلومات المتجر",
    mobile: "الهاتف",
    newStore: "متجر جديد",
    noProducts: {
      body: "لم يُدرج هذا المتجر أي منتجات بعد.",
      title: "لا توجد منتجات بعد",
    },
    open: "مفتوح",
    policies: "السياسات",
    products: "المنتجات",
    returns: "الإرجاع والاستبدال",
    support: "خدمة العملاء",
    terms: "الشروط",
    whatsapp: "واتساب",
  },
} as const;
