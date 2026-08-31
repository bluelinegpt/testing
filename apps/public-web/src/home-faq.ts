// Homepage FAQ content (EN/AR), from the approved SEO content plan. Four of
// the drafted questions arrived marked "confirm before publishing"
// (integrations, cities, trial, cost) -- those answers below are written
// strictly from facts already published elsewhere on this site (the pricing
// page's Free plan and AED tiers, the Trader Portal commerce-integrations
// positioning, the UAE-wide positioning), never beyond them.
export interface HomeFaq {
  readonly q: { readonly en: string; readonly ar: string };
  readonly a: { readonly en: string; readonly ar: string };
}

export const homeFaqs: readonly HomeFaq[] = [
  {
    q: { en: "What is Tawseelhub?", ar: "ما هو Tawseelhub؟" },
    a: {
      en: "Tawseelhub is a delivery operating system built for UAE delivery companies, helping them manage orders, drivers, cash on delivery (COD), trader settlements, accounting, and payroll in one platform.",
      ar: "Tawseelhub هو نظام تشغيل توصيل مصمم لشركات التوصيل في الإمارات، يساعدها على إدارة الطلبات والسائقين والدفع عند الاستلام وتسويات التجار والمحاسبة والرواتب في منصة واحدة.",
    },
  },
  {
    q: { en: "Who is Tawseelhub designed for?", ar: "لمن صُمم Tawseelhub؟" },
    a: {
      en: "It's built for delivery and courier companies, last-mile logistics providers, and businesses managing their own fleet of delivery drivers across the UAE.",
      ar: "صُمم لشركات التوصيل والشحن، ومزودي خدمات التوصيل للميل الأخير، والأعمال التي تدير أسطول سائقيها الخاص في جميع أنحاء الإمارات.",
    },
  },
  {
    q: {
      en: "Can Tawseelhub handle Cash on Delivery (COD) management?",
      ar: "هل يدعم Tawseelhub إدارة الدفع عند الاستلام (COD)؟",
    },
    a: {
      en: "Yes. Tawseelhub tracks COD collections from drivers, reconciles cash against orders, and helps prevent discrepancies in real time — a complete COD reconciliation software workflow.",
      ar: "نعم. يتتبع Tawseelhub تحصيلات الدفع عند الاستلام من السائقين، ويطابق النقد مقابل الطلبات، ويساعد على منع الفروقات في الوقت الفعلي.",
    },
  },
  {
    q: { en: "Does Tawseelhub support driver management?", ar: "هل يدعم Tawseelhub إدارة السائقين؟" },
    a: {
      en: "Yes, it includes tools to assign orders, track driver performance, monitor deliveries, and manage driver payroll — a full delivery driver management app for UAE operations.",
      ar: "نعم، يتضمن أدوات لإسناد الطلبات، وتتبع أداء السائقين، ومراقبة عمليات التوصيل، وإدارة رواتب السائقين.",
    },
  },
  {
    q: {
      en: 'What is "trader settlement" in Tawseelhub?',
      ar: 'ما المقصود بـ "تسوية التجار" في Tawseelhub؟',
    },
    a: {
      en: "Trader settlement refers to reconciling and paying merchants or traders whose orders were delivered — Tawseelhub automates this calculation and payout tracking.",
      ar: "تسوية التجار تعني مطابقة ودفع مستحقات التجار الذين تم توصيل طلباتهم — يقوم Tawseelhub بأتمتة هذا الاحتساب وتتبع المدفوعات.",
    },
  },
  {
    q: {
      en: "Does Tawseelhub include accounting features?",
      ar: "هل يتضمن Tawseelhub ميزات محاسبية؟",
    },
    a: {
      en: "Yes, Tawseelhub integrates accounting functions so delivery companies can track revenue, expenses, and settlements without needing a separate system.",
      ar: "نعم، يدمج Tawseelhub وظائف المحاسبة حتى تتمكن شركات التوصيل من تتبع الإيرادات والمصروفات والتسويات دون الحاجة إلى نظام منفصل.",
    },
  },
  {
    q: {
      en: "Can I manage driver payroll through Tawseelhub?",
      ar: "هل يمكنني إدارة رواتب السائقين عبر Tawseelhub؟",
    },
    a: {
      en: "Yes, payroll management is built into the platform, factoring in deliveries completed, COD handled, and other performance metrics.",
      ar: "نعم، إدارة الرواتب مدمجة في المنصة، مع احتساب التوصيلات المنجزة والتحصيلات النقدية ومؤشرات الأداء الأخرى.",
    },
  },
  {
    q: {
      en: "Is Tawseelhub only for large delivery companies?",
      ar: "هل Tawseelhub مخصص لشركات التوصيل الكبيرة فقط؟",
    },
    a: {
      en: "No — it's designed to scale for both small and large delivery operations across the UAE.",
      ar: "لا — فهو مصمم ليتوسع مع عمليات التوصيل الصغيرة والكبيرة على حد سواء في جميع أنحاء الإمارات.",
    },
  },
  {
    q: {
      en: "Does Tawseelhub offer real-time order tracking?",
      ar: "هل يوفر Tawseelhub تتبعاً للطلبات في الوقت الفعلي؟",
    },
    a: {
      en: "Yes, businesses and their customers can track order status from dispatch to delivery.",
      ar: "نعم، يمكن للشركات وعملائها تتبع حالة الطلب من الإرسال حتى التسليم.",
    },
  },
  {
    q: { en: "Is Tawseelhub cloud-based?", ar: "هل يعمل Tawseelhub على السحابة؟" },
    a: {
      en: "Yes, Tawseelhub operates as a cloud-based platform, accessible from anywhere without heavy on-premise infrastructure.",
      ar: "نعم، يعمل Tawseelhub كمنصة سحابية يمكن الوصول إليها من أي مكان دون الحاجة إلى بنية تحتية محلية ثقيلة.",
    },
  },
  {
    q: {
      en: "Can Tawseelhub integrate with existing e-commerce systems?",
      ar: "هل يتكامل Tawseelhub مع أنظمة التجارة الإلكترونية الحالية؟",
    },
    a: {
      en: "Yes — Tawseelhub's Trader Portal is built to connect order intake from the sales channels Traders already use, such as Salla, Shopify and WooCommerce.",
      ar: "نعم — بوابة التجار في Tawseelhub مصممة لربط استقبال الطلبات من قنوات البيع التي يستخدمها التجار بالفعل، مثل سلة وشوبيفاي وووكومرس.",
    },
  },
  {
    q: { en: "What UAE cities does Tawseelhub support?", ar: "ما المدن الإماراتية التي يدعمها Tawseelhub؟" },
    a: {
      en: "Tawseelhub supports delivery companies across the UAE, including Dubai, Abu Dhabi, Sharjah and Ajman.",
      ar: "يدعم Tawseelhub شركات التوصيل في جميع أنحاء الإمارات، بما في ذلك دبي وأبوظبي والشارقة وعجمان.",
    },
  },
  {
    q: {
      en: "How does Tawseelhub help reduce delivery errors?",
      ar: "كيف يساعد Tawseelhub على تقليل أخطاء التوصيل؟",
    },
    a: {
      en: "By centralizing order assignment, driver tracking, and COD reconciliation, Tawseelhub reduces manual errors common in spreadsheet- or paper-based delivery operations.",
      ar: "من خلال مركزية إسناد الطلبات وتتبع السائقين ومطابقة التحصيلات النقدية، يقلل Tawseelhub الأخطاء اليدوية الشائعة في العمليات المعتمدة على الجداول أو الورق.",
    },
  },
  {
    q: { en: "Is there a free trial or demo available?", ar: "هل تتوفر تجربة مجانية أو عرض توضيحي؟" },
    a: {
      en: "Yes — you can request a demo, and the Free plan gives free access for up to 100 orders per month.",
      ar: "نعم — يمكنك طلب عرض توضيحي، كما تمنح الخطة المجانية وصولاً مجانياً حتى 100 طلب شهرياً.",
    },
  },
  {
    q: { en: "How much does Tawseelhub cost?", ar: "كم تبلغ تكلفة Tawseelhub؟" },
    a: {
      en: "Tawseelhub starts free for up to 100 orders per month, with monthly AED plans as your delivery volume grows — see the pricing page for full details.",
      ar: "يبدأ Tawseelhub مجاناً حتى 100 طلب شهرياً، مع خطط شهرية بالدرهم الإماراتي مع نمو حجم التوصيل — راجع صفحة الأسعار للتفاصيل الكاملة.",
    },
  },
];
