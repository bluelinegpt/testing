// Approved public FAQ knowledge for the Tawseelhub assistant (Yousef),
// mirroring the 15 FAQs published on the tawseelhub.com homepage. Matched
// DETERMINISTICALLY before any model call so every one of these questions
// gets its approved answer verbatim -- never a paraphrase, never a refusal.
//
// Matching is deliberately conservative: each entry needs its own subject
// keywords, so ordinary workflow starts ("track my shipment") and slot
// answers can never be swallowed as an FAQ. This runs only inside the
// general-question path, after workflow routing has already happened.
import type { AgentLanguage } from "./agent.types.js";

interface AgentFaqEntry {
  readonly id: string;
  readonly pattern: RegExp;
  readonly en: string;
  readonly ar: string;
}

const entries: readonly AgentFaqEntry[] = [
  {
    id: "what-is-tawseelhub",
    pattern:
      /what(?:'s| is) (?:tawseelhub|توصيل هب)|about tawseelhub|tell me about (?:tawseelhub|the platform)|ما هو (?:توصيل هب|تاوسيل هب|tawseelhub)|ايش هو تawseelhub|شو هو (?:توصيل هب|tawseelhub)/iu,
    en: "Tawseelhub is a delivery operating system built for UAE delivery companies, helping them manage orders, drivers, cash on delivery (COD), trader settlements, accounting, and payroll in one platform.",
    ar: "Tawseelhub هو نظام تشغيل توصيل مصمم لشركات التوصيل في الإمارات، يساعدها على إدارة الطلبات والسائقين والدفع عند الاستلام وتسويات التجار والمحاسبة والرواتب في منصة واحدة.",
  },
  {
    id: "who-is-it-for",
    pattern:
      /who is (?:tawseelhub|it|this) (?:designed |built |made )?for|who (?:should|can) use|target (?:audience|customers)|لمن (?:صمم|مصمم|موجه)|لمين (?:النظام|المنصة)|من يستخدم/iu,
    en: "It's built for delivery and courier companies, last-mile logistics providers, and businesses managing their own fleet of delivery drivers across the UAE.",
    ar: "صُمم لشركات التوصيل والشحن، ومزودي خدمات التوصيل للميل الأخير، والأعمال التي تدير أسطول سائقيها الخاص في جميع أنحاء الإمارات.",
  },
  {
    id: "cod-management",
    pattern:
      /\bcod\b.*(?:manage|management|handle|support|reconcil)|(?:manage|handle|support|reconcil).*\bcod\b|cash on delivery.*(?:manage|handle|support|reconcil)|(?:إدارة|يدعم|مطابقة|تحصيل).*الدفع عند الاستلام|الدفع عند الاستلام.*(?:إدارة|يدعم|مطابقة)/iu,
    en: "Yes. Tawseelhub tracks COD collections from drivers, reconciles cash against orders, and helps prevent discrepancies in real time — a complete COD reconciliation workflow.",
    ar: "نعم. يتتبع Tawseelhub تحصيلات الدفع عند الاستلام من السائقين، ويطابق النقد مقابل الطلبات، ويساعد على منع الفروقات في الوقت الفعلي.",
  },
  {
    id: "driver-management",
    pattern:
      /(?:support|include|offer|have|handle).*driver management|driver management.*(?:support|include|offer|work)|manage (?:my )?drivers|هل يدعم.*إدارة السائقين|إدارة السائقين.*(?:يدعم|متوفرة|موجودة)|أدير السائقين/iu,
    en: "Yes, it includes tools to assign orders, track driver performance, monitor deliveries, and manage driver payroll — a full driver management workflow for UAE operations.",
    ar: "نعم، يتضمن أدوات لإسناد الطلبات، وتتبع أداء السائقين، ومراقبة عمليات التوصيل، وإدارة رواتب السائقين.",
  },
  {
    id: "trader-settlement",
    pattern:
      /what(?:'s| is) (?:a )?trader settlement|trader settlement.*(?:mean|work|refer)|explain trader settlement|ما (?:هي|معنى|المقصود بـ?) ?تسوي(?:ة|ات) التجار|شو يعني تسوية التجار/iu,
    en: "Trader settlement refers to reconciling and paying merchants or traders whose orders were delivered — Tawseelhub automates this calculation and payout tracking.",
    ar: "تسوية التجار تعني مطابقة ودفع مستحقات التجار الذين تم توصيل طلباتهم — يقوم Tawseelhub بأتمتة هذا الاحتساب وتتبع المدفوعات.",
  },
  {
    id: "accounting",
    pattern:
      /(?:include|offer|support|have|handle).*accounting|accounting (?:features?|functions?|module)|هل (?:يتضمن|يدعم|يوفر).*محاسب|ميزات محاسبية|المحاسبة (?:متوفرة|موجودة)/iu,
    en: "Yes, Tawseelhub integrates accounting functions so delivery companies can track revenue, expenses, and settlements without needing a separate system.",
    ar: "نعم، يدمج Tawseelhub وظائف المحاسبة حتى تتمكن شركات التوصيل من تتبع الإيرادات والمصروفات والتسويات دون الحاجة إلى نظام منفصل.",
  },
  {
    id: "driver-payroll",
    pattern:
      /(?:manage|handle|support|include|offer).*(?:driver )?payroll|payroll.*(?:manage|support|include|through)|رواتب السائقين|إدارة الرواتب|هل (?:يدعم|يمكن).*الرواتب/iu,
    en: "Yes, payroll management is built into the platform, factoring in deliveries completed, COD handled, and other performance metrics.",
    ar: "نعم، إدارة الرواتب مدمجة في المنصة، مع احتساب التوصيلات المنجزة والتحصيلات النقدية ومؤشرات الأداء الأخرى.",
  },
  {
    id: "company-size",
    pattern:
      /only for (?:large|big|small)|(?:large|big|small) (?:delivery )?compan(?:y|ies) only|(?:small|smaller) (?:delivery )?compan(?:y|ies).*(?:use|suitable|work)|suitable for small|هل هو فقط للشركات الكبيرة|للشركات الصغيرة|يناسب الشركات الصغيرة/iu,
    en: "No — it's designed to scale for both small and large delivery operations across the UAE.",
    ar: "لا — فهو مصمم ليتوسع مع عمليات التوصيل الصغيرة والكبيرة على حد سواء في جميع أنحاء الإمارات.",
  },
  {
    id: "real-time-tracking",
    pattern:
      /(?:offer|support|have|include|provide).*(?:real.?time|live).*track|(?:real.?time|live) (?:order )?tracking|هل (?:يوفر|يدعم|يوجد).*تتبع.*(?:مباشر|فوري|لحظي)|تتبع (?:مباشر|فوري|لحظي)/iu,
    en: "Yes, businesses and their customers can track order status from dispatch to delivery.",
    ar: "نعم، يمكن للشركات وعملائها تتبع حالة الطلب من الإرسال حتى التسليم.",
  },
  {
    id: "cloud-based",
    pattern:
      /cloud.?based|on.?premise|(?:run|work|hosted).*(?:on the )?cloud|هل يعمل على السحابة|سحاب(?:ي|ة)|خوادم محلية/iu,
    en: "Yes, Tawseelhub operates as a cloud-based platform, accessible from anywhere without heavy on-premise infrastructure.",
    ar: "نعم، يعمل Tawseelhub كمنصة سحابية يمكن الوصول إليها من أي مكان دون الحاجة إلى بنية تحتية محلية ثقيلة.",
  },
  {
    id: "ecommerce-integration",
    pattern:
      /integrat(?:e|ion).*(?:e-?commerce|shopify|salla|woocommerce|pos|store)|(?:e-?commerce|shopify|salla|woocommerce|pos).*integrat|connect.*(?:shopify|salla|woocommerce)|(?:تكامل|يتكامل|ربط).*(?:التجارة|سلة|شوبيفاي|ووكومرس|متجر)|(?:سلة|شوبيفاي|ووكومرس).*(?:تكامل|ربط)/iu,
    en: "Yes — Tawseelhub's Trader Portal is built to connect order intake from the sales channels Traders already use, such as Salla, Shopify and WooCommerce.",
    ar: "نعم — بوابة التجار في Tawseelhub مصممة لربط استقبال الطلبات من قنوات البيع التي يستخدمها التجار بالفعل، مثل سلة وشوبيفاي وووكومرس.",
  },
  {
    id: "cities-coverage",
    pattern:
      /(?:what|which).*(?:cities|emirates).*(?:support|cover|serve)|(?:support|cover|serve|available).*(?:cities|emirates|dubai|abu dhabi|sharjah|ajman)|(?:أي|ما هي).*(?:مدن|إمارات)|(?:يدعم|يغطي|متوفر).*(?:مدن|دبي|أبوظبي|الشارقة|عجمان)/iu,
    en: "Tawseelhub supports delivery companies across the UAE, including Dubai, Abu Dhabi, Sharjah and Ajman.",
    ar: "يدعم Tawseelhub شركات التوصيل في جميع أنحاء الإمارات، بما في ذلك دبي وأبوظبي والشارقة وعجمان.",
  },
  {
    id: "reduce-errors",
    pattern:
      /(?:reduce|prevent|avoid|less).*(?:delivery )?(?:errors?|mistakes?|discrepanc)|(?:errors?|mistakes?).*(?:reduce|prevent|help)|(?:تقليل|يقلل|منع|تجنب).*(?:أخطاء|الأخطاء|الفروقات)|(?:أخطاء|الأخطاء).*(?:تقليل|يقلل)/iu,
    en: "By centralizing order assignment, driver tracking, and COD reconciliation, Tawseelhub reduces manual errors common in spreadsheet- or paper-based delivery operations.",
    ar: "من خلال مركزية إسناد الطلبات وتتبع السائقين ومطابقة التحصيلات النقدية، يقلل Tawseelhub الأخطاء اليدوية الشائعة في العمليات المعتمدة على الجداول أو الورق.",
  },
  {
    id: "free-trial",
    pattern:
      /free trial|trial.*(?:available|offer)|(?:is there|do you (?:have|offer)).*(?:trial|demo)|try (?:it |tawseelhub )?(?:for )?free|تجربة مجانية|نسخة تجريبية|هل (?:يوجد|تتوفر|في).*(?:تجربة|ديمو|عرض توضيحي)/iu,
    en: "Yes — you can request a demo, and the Free plan gives free access for up to 100 orders per month.",
    ar: "نعم — يمكنك طلب عرض توضيحي، كما تمنح الخطة المجانية وصولاً مجانياً حتى 100 طلب شهرياً.",
  },
  {
    id: "cost",
    pattern:
      /how much (?:does|is|will).*(?:cost|tawseelhub)|(?:price|pricing|cost) of tawseelhub|tawseelhub (?:price|pricing|cost)|subscription (?:price|cost|fee)|كم (?:تكلفة|سعر|يكلف)|تكلفة (?:النظام|المنصة|الاشتراك)|سعر الاشتراك/iu,
    en: "Tawseelhub starts free for up to 100 orders per month, with monthly AED plans as your delivery volume grows. Full details: https://tawseelhub.com/pricing",
    ar: "يبدأ Tawseelhub مجاناً حتى 100 طلب شهرياً، مع خطط شهرية بالدرهم الإماراتي مع نمو حجم التوصيل. التفاصيل الكاملة: https://tawseelhub.com/pricing",
  },
];

/**
 * Returns the approved FAQ answer for a visitor message, or undefined when
 * no FAQ matches. Called only from the general-question path -- workflow
 * routing (tracking, quotes, registrations) has already had its turn.
 */
export function agentFaqAnswer(text: string, language: AgentLanguage): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const match = entries.find((entry) => entry.pattern.test(trimmed));
  if (!match) return undefined;
  return language === "ar" ? match.ar : match.en;
}
