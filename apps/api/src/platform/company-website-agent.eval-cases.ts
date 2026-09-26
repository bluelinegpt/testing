export type WebsiteAgentEvalCategory =
  | "coverage_service"
  | "pricing_quote"
  | "cod_finance"
  | "tracking_status"
  | "complaint_exception";

export type WebsiteAgentExpectedBehavior =
  | "published_facts_only"
  | "quote_or_lead"
  | "secure_tracking_or_handoff"
  | "complaint_handoff";

export interface WebsiteAgentEvalCase {
  id: number;
  category: WebsiteAgentEvalCategory;
  expected: WebsiteAgentExpectedBehavior;
  en: string;
  ar: string;
}

/**
 * Company-neutral bilingual regression corpus for the public Website Agent.
 * These are evaluation inputs, never company facts or canned answers. The
 * expected response must always be grounded in the resolved Company's own
 * published settings and permitted public workflows.
 */
export const COMPANY_WEBSITE_AGENT_EVAL_CASES: readonly WebsiteAgentEvalCase[] = [
  { id: 1, category: "coverage_service", expected: "published_facts_only", en: "Do you deliver to remote areas outside the main cities in the UAE?", ar: "هل توصلون إلى المناطق البعيدة خارج المدن الرئيسية في الإمارات؟" },
  { id: 2, category: "coverage_service", expected: "published_facts_only", en: "Do you deliver to Al Ain as well?", ar: "هل توصلون إلى مدينة العين أيضاً؟" },
  { id: 3, category: "coverage_service", expected: "published_facts_only", en: "Can you pick up a package from Ajman and deliver it to Fujairah?", ar: "هل يمكنكم استلام طرد من عجمان وتوصيله إلى الفجيرة؟" },
  { id: 4, category: "coverage_service", expected: "published_facts_only", en: "Do you provide same-day delivery?", ar: "هل توفرون خدمة التوصيل في اليوم نفسه؟" },
  { id: 5, category: "coverage_service", expected: "published_facts_only", en: "Do you provide next-day delivery?", ar: "هل توفرون خدمة التوصيل في اليوم التالي؟" },
  { id: 6, category: "coverage_service", expected: "quote_or_lead", en: "Can I schedule a pickup for tomorrow morning?", ar: "هل يمكنني جدولة استلام طرد صباح الغد؟" },
  { id: 7, category: "coverage_service", expected: "published_facts_only", en: "Can you collect a package from my home or only from businesses?", ar: "هل يمكنكم استلام طرد من منزلي أم أن الاستلام متاح للشركات فقط؟" },
  { id: 8, category: "coverage_service", expected: "published_facts_only", en: "Do you deliver on Fridays and public holidays?", ar: "هل توصلون أيام الجمعة والعطلات الرسمية؟" },
  { id: 9, category: "coverage_service", expected: "published_facts_only", en: "What time do your drivers normally start deliveries?", ar: "في أي وقت يبدأ السائقون عمليات التوصيل عادةً؟" },
  { id: 10, category: "coverage_service", expected: "published_facts_only", en: "What is the latest time I can request a pickup today?", ar: "ما آخر وقت يمكنني فيه طلب استلام طرد اليوم؟" },
  { id: 11, category: "pricing_quote", expected: "published_facts_only", en: "How do you calculate your delivery price?", ar: "كيف تحسبون سعر التوصيل؟" },
  { id: 12, category: "pricing_quote", expected: "published_facts_only", en: "Is the delivery price different depending on the Emirate?", ar: "هل يختلف سعر التوصيل حسب الإمارة؟" },
  { id: 13, category: "pricing_quote", expected: "quote_or_lead", en: "I have one package from Sharjah to Dubai. How much will it cost?", ar: "لدي طرد واحد من الشارقة إلى دبي. كم ستكون التكلفة؟" },
  { id: 14, category: "pricing_quote", expected: "quote_or_lead", en: "If I send 100 orders every week, can I get a better rate?", ar: "إذا أرسلت 100 طلب كل أسبوع، هل يمكنني الحصول على سعر أفضل؟" },
  { id: 15, category: "pricing_quote", expected: "published_facts_only", en: "Do you charge extra for Cash on Delivery?", ar: "هل تفرضون رسوماً إضافية على خدمة الدفع عند الاستلام؟" },
  { id: 16, category: "pricing_quote", expected: "published_facts_only", en: "Is there an additional charge if the customer refuses the shipment?", ar: "هل توجد رسوم إضافية إذا رفض العميل الشحنة؟" },
  { id: 17, category: "pricing_quote", expected: "published_facts_only", en: "Do you charge for a second delivery attempt?", ar: "هل تفرضون رسوماً على محاولة التوصيل الثانية؟" },
  { id: 18, category: "pricing_quote", expected: "published_facts_only", en: "Do you charge more for heavy packages?", ar: "هل تفرضون رسوماً أعلى على الطرود الثقيلة؟" },
  { id: 19, category: "pricing_quote", expected: "quote_or_lead", en: "My package is 12 kg. Can you deliver it and how much would it cost?", ar: "وزن طردي 12 كجم. هل يمكنكم توصيله وكم ستكون التكلفة؟" },
  { id: 20, category: "pricing_quote", expected: "published_facts_only", en: "Can you give me your full price list for all UAE areas?", ar: "هل يمكنكم تزويدي بقائمة الأسعار الكاملة لجميع مناطق الإمارات؟" },
  { id: 21, category: "cod_finance", expected: "published_facts_only", en: "Do you support COD for all Emirates?", ar: "هل تدعمون الدفع عند الاستلام في جميع الإمارات؟" },
  { id: 22, category: "cod_finance", expected: "published_facts_only", en: "Can the customer pay the driver by card instead of cash?", ar: "هل يمكن للعميل الدفع للسائق بالبطاقة بدلاً من النقد؟" },
  { id: 23, category: "cod_finance", expected: "published_facts_only", en: "Can the customer pay by bank transfer when the driver arrives?", ar: "هل يمكن للعميل الدفع بتحويل بنكي عند وصول السائق؟" },
  { id: 24, category: "cod_finance", expected: "published_facts_only", en: "My order value is AED 1,500. Can you collect this amount as COD?", ar: "قيمة طلبي 1,500 درهم. هل يمكنكم تحصيل هذا المبلغ عند الاستلام؟" },
  { id: 25, category: "cod_finance", expected: "published_facts_only", en: "Is there a maximum COD amount you can collect?", ar: "هل يوجد حد أقصى لمبلغ الدفع عند الاستلام الذي يمكنكم تحصيله؟" },
  { id: 26, category: "cod_finance", expected: "published_facts_only", en: "How can I check how much COD your drivers collected for me today?", ar: "كيف يمكنني معرفة إجمالي مبالغ الدفع عند الاستلام التي حصلها السائقون لي اليوم؟" },
  { id: 27, category: "cod_finance", expected: "published_facts_only", en: "Can you send my COD settlement directly to my bank account?", ar: "هل يمكنكم تحويل تسوية الدفع عند الاستلام مباشرةً إلى حسابي البنكي؟" },
  { id: 28, category: "cod_finance", expected: "published_facts_only", en: "Do you deduct the delivery fee before sending me my COD money?", ar: "هل تخصمون رسوم التوصيل قبل إرسال مبالغ الدفع عند الاستلام إليّ؟" },
  { id: 29, category: "cod_finance", expected: "complaint_handoff", en: "I think one COD payment is missing from my settlement. What should I do?", ar: "أعتقد أن إحدى دفعات الدفع عند الاستلام مفقودة من تسويتي. ماذا أفعل؟" },
  { id: 30, category: "cod_finance", expected: "complaint_handoff", en: "My customer paid cash but the system still says payment pending. Can you check?", ar: "دفع عميلي نقداً لكن النظام ما زال يعرض أن الدفع معلق. هل يمكنكم التحقق؟" },
  { id: 31, category: "tracking_status", expected: "secure_tracking_or_handoff", en: "How can I track my shipment?", ar: "كيف يمكنني تتبع شحنتي؟" },
  { id: 32, category: "tracking_status", expected: "complaint_handoff", en: "My package was picked up yesterday but the status has not changed. Why?", ar: "تم استلام طردي بالأمس لكن الحالة لم تتغير. لماذا؟" },
  { id: 33, category: "tracking_status", expected: "published_facts_only", en: "What does ‘Out for Delivery’ mean?", ar: "ماذا تعني حالة «خرج للتوصيل»؟" },
  { id: 34, category: "tracking_status", expected: "published_facts_only", en: "What does ‘Returned to Branch’ mean?", ar: "ماذا تعني حالة «مرتجع إلى الفرع»؟" },
  { id: 35, category: "tracking_status", expected: "secure_tracking_or_handoff", en: "My shipment says delivered. Can you tell me exactly who received it?", ar: "تظهر شحنتي أنها تم تسليمها. هل يمكنكم إخباري بمن استلمها تحديداً؟" },
  { id: 36, category: "tracking_status", expected: "secure_tracking_or_handoff", en: "Can you show me proof of delivery?", ar: "هل يمكنكم عرض إثبات التسليم؟" },
  { id: 37, category: "tracking_status", expected: "secure_tracking_or_handoff", en: "Can you tell me what time the driver will arrive?", ar: "هل يمكنكم إخباري بوقت وصول السائق؟" },
  { id: 38, category: "tracking_status", expected: "complaint_handoff", en: "My order has been out for delivery all day. Is there a problem?", ar: "طلبي في حالة خرج للتوصيل طوال اليوم. هل توجد مشكلة؟" },
  { id: 39, category: "tracking_status", expected: "secure_tracking_or_handoff", en: "Can I change the delivery address after the driver has already started?", ar: "هل يمكنني تغيير عنوان التوصيل بعد أن بدأ السائق الرحلة؟" },
  { id: 40, category: "tracking_status", expected: "secure_tracking_or_handoff", en: "Can I change the customer's phone number after the order was created?", ar: "هل يمكنني تغيير رقم هاتف العميل بعد إنشاء الطلب؟" },
  { id: 41, category: "complaint_exception", expected: "complaint_handoff", en: "My package arrived damaged. How do I file a complaint?", ar: "وصل طردي تالفاً. كيف أقدم شكوى؟" },
  { id: 42, category: "complaint_exception", expected: "complaint_handoff", en: "The driver did not call the customer before marking the order failed. What can I do?", ar: "لم يتصل السائق بالعميل قبل تسجيل فشل الطلب. ماذا يمكنني أن أفعل؟" },
  { id: 43, category: "complaint_exception", expected: "complaint_handoff", en: "Your driver was rude to my customer. I want to complain.", ar: "تعامل السائق بطريقة غير لائقة مع عميلي وأريد تقديم شكوى." },
  { id: 44, category: "complaint_exception", expected: "complaint_handoff", en: "The customer says the driver asked for more money than the COD amount. What should I do?", ar: "يقول العميل إن السائق طلب مبلغاً أكبر من مبلغ الدفع عند الاستلام. ماذا أفعل؟" },
  { id: 45, category: "complaint_exception", expected: "complaint_handoff", en: "My package was delivered to the wrong person. How will you fix this?", ar: "تم تسليم طردي إلى الشخص الخطأ. كيف ستعالجون الأمر؟" },
  { id: 46, category: "complaint_exception", expected: "complaint_handoff", en: "My shipment has been missing for three days. Can you locate it?", ar: "شحنتي مفقودة منذ ثلاثة أيام. هل يمكنكم تحديد مكانها؟" },
  { id: 47, category: "complaint_exception", expected: "secure_tracking_or_handoff", en: "The customer changed their mind and wants the order tomorrow instead. Can you reschedule it?", ar: "غيّر العميل رأيه ويريد الطلب غداً بدلاً من اليوم. هل يمكنكم إعادة جدولته؟" },
  { id: 48, category: "complaint_exception", expected: "secure_tracking_or_handoff", en: "I accidentally created the same shipment twice. Can one of them be cancelled?", ar: "أنشأت الشحنة نفسها مرتين بالخطأ. هل يمكن إلغاء إحداهما؟" },
  { id: 49, category: "complaint_exception", expected: "secure_tracking_or_handoff", en: "I want to cancel my order, but the driver already has the package. What happens now?", ar: "أريد إلغاء طلبي، لكن الطرد موجود بالفعل مع السائق. ماذا سيحدث الآن؟" },
  { id: 50, category: "complaint_exception", expected: "complaint_handoff", en: "The customer refused the shipment because the package looked damaged. Who is responsible?", ar: "رفض العميل الشحنة لأن الطرد بدا تالفاً. من المسؤول؟" },
];
