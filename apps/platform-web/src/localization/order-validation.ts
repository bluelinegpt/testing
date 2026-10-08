/**
 * English and Arabic copy for Repair Center Order Validation (spec §3).
 *
 * The API returns `titleKey` / `descriptionKey` for every check
 * (`platform.orderValidation.<code>.title`, plus `.strong.` for the stronger
 * V1 warning). platform-web has no app-wide translation loader, so the
 * Validation UI (Phase 3) reads its copy from here via `orderValidationText`.
 * `order-validation.test.ts` fails if a check code or language is missing.
 */

export type OrderValidationLanguage = "en" | "ar";

export const ORDER_VALIDATION_COPY_KEYS = [
  "L1",
  "L2",
  "L3",
  "F1",
  "F2",
  "F3",
  "F4",
  "D1",
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "V1",
  "V1.strong",
  "V2",
] as const;
export type OrderValidationCopyKey = (typeof ORDER_VALIDATION_COPY_KEYS)[number];

interface Copy {
  readonly title: string;
  readonly description: string;
}

export const orderValidationLocalization: Record<
  OrderValidationLanguage,
  Record<OrderValidationCopyKey, Copy>
> = {
  en: {
    L1: {
      title: "Status history",
      description:
        "The Order's delivery status matches its latest status history entry and status event.",
    },
    L2: {
      title: "Delivery and close dates",
      description:
        "Delivered and closed Orders have a delivery date; only closed Orders have a close date.",
    },
    L3: {
      title: "Driver assignment",
      description: "The assigned driver matches the Order's open assignment record.",
    },
    F1: {
      title: "Order amounts",
      description:
        "Every stored amount equals the amount recalculated from the Order's COD, fees, payment condition and VAT.",
    },
    F2: {
      title: "Trader settlement",
      description:
        "The settlement status matches the amount owed to the Trader, and the paid amount matches the effective settlements.",
    },
    F3: {
      title: "Closed Order settled",
      description: "A closed Order has completed its Trader settlement.",
    },
    F4: {
      title: "Trader fee receivable",
      description:
        "When the Trader pays the fee, one service charge receivable exists with the right amount and status.",
    },
    D1: {
      title: "Driver cash",
      description:
        "The driver reconciliation line equals the amount due from the customer, and the reconciliation is confirmed.",
    },
    A1: {
      title: "Accounting recognition",
      description:
        "A delivered or closed Order has exactly one effective posted recognition journal.",
    },
    A2: {
      title: "Recognition journal amounts",
      description:
        "The posted recognition journal matches what the Order's current values would post today. A difference means the Order changed after posting.",
    },
    A3: {
      title: "Accounting processing",
      description:
        "No accounting event for this Order is failed, waiting for retry or blocked by configuration.",
    },
    A4: {
      title: "Recognition after reversal",
      description:
        "If the recognition was reversed and the Order is delivered again, a new recognition has been posted.",
    },
    A5: {
      title: "Accounting status field",
      description:
        "The Order's accounting status field is not maintained by the system; this is shown for information only.",
    },
    V1: {
      title: "Additional fee with no COD",
      description:
        "The Trader receives nothing for this Order; the whole amount is Company revenue. If the additional fee is the goods value, use Move Additional Fee to COD.",
    },
    "V1.strong": {
      title: "Additional fee larger than the service fee, with no COD",
      description:
        "The Trader receives nothing for this Order and the additional fee is larger than the service fee, so it is likely the goods value. If so, use Move Additional Fee to COD.",
    },
    V2: {
      title: "COD removed before delivery",
      description: "COD was removed before delivery. Confirm the customer did not pay the driver.",
    },
  },
  ar: {
    L1: {
      title: "سجل الحالة",
      description: "حالة توصيل الطلب تطابق آخر قيد في سجل الحالة وآخر حدث للحالة.",
    },
    L2: {
      title: "تاريخا التسليم والإغلاق",
      description: "للطلبات المسلّمة والمغلقة تاريخ تسليم، وللطلبات المغلقة فقط تاريخ إغلاق.",
    },
    L3: { title: "تعيين السائق", description: "السائق المعيّن يطابق سجل التعيين المفتوح للطلب." },
    F1: {
      title: "مبالغ الطلب",
      description:
        "كل مبلغ مخزّن يساوي المبلغ المعاد حسابه من مبلغ الدفع عند الاستلام والرسوم وشرط الدفع وضريبة القيمة المضافة.",
    },
    F2: {
      title: "تسوية التاجر",
      description:
        "حالة التسوية تطابق المبلغ المستحق للتاجر، والمبلغ المدفوع يطابق التسويات السارية.",
    },
    F3: { title: "تسوية الطلب المغلق", description: "الطلب المغلق أكمل تسوية التاجر." },
    F4: {
      title: "ذمة رسوم التاجر",
      description: "عندما يدفع التاجر الرسوم، توجد ذمة رسوم خدمة واحدة بالمبلغ والحالة الصحيحين.",
    },
    D1: {
      title: "نقد السائق",
      description: "سطر مطابقة السائق يساوي المبلغ المستحق من العميل، والمطابقة مؤكدة.",
    },
    A1: {
      title: "الاعتراف المحاسبي",
      description: "للطلب المسلّم أو المغلق قيد اعتراف واحد فقط مرحّل وساري.",
    },
    A2: {
      title: "مبالغ قيد الاعتراف",
      description:
        "قيد الاعتراف المرحّل يطابق ما ستُرحّله قيم الطلب الحالية اليوم. الاختلاف يعني أن الطلب تغيّر بعد الترحيل.",
    },
    A3: {
      title: "معالجة المحاسبة",
      description:
        "لا يوجد حدث محاسبي لهذا الطلب فاشل أو بانتظار إعادة المحاولة أو موقوف بسبب الإعدادات.",
    },
    A4: {
      title: "الاعتراف بعد العكس",
      description: "إذا عُكس الاعتراف وأصبح الطلب مسلّماً من جديد، فقد رُحّل اعتراف جديد.",
    },
    A5: {
      title: "حقل الحالة المحاسبية",
      description: "حقل الحالة المحاسبية للطلب لا يحدّثه النظام؛ يُعرض للعلم فقط.",
    },
    V1: {
      title: "رسوم إضافية بدون دفع عند الاستلام",
      description:
        "لا يحصل التاجر على أي مبلغ من هذا الطلب؛ المبلغ كله إيراد للشركة. إذا كانت الرسوم الإضافية هي قيمة البضاعة، فاستخدم نقل الرسوم الإضافية إلى الدفع عند الاستلام.",
    },
    "V1.strong": {
      title: "رسوم إضافية أكبر من رسوم الخدمة بدون دفع عند الاستلام",
      description:
        "لا يحصل التاجر على أي مبلغ من هذا الطلب، والرسوم الإضافية أكبر من رسوم الخدمة، فالأرجح أنها قيمة البضاعة. إن كان كذلك، فاستخدم نقل الرسوم الإضافية إلى الدفع عند الاستلام.",
    },
    V2: {
      title: "حذف الدفع عند الاستلام قبل التسليم",
      description: "حُذف مبلغ الدفع عند الاستلام قبل التسليم. تأكد أن العميل لم يدفع للسائق.",
    },
  },
};

const KEY_PATTERN = /^platform\.orderValidation\.(.+)\.(title|description)$/u;

/** Resolves an API `titleKey` / `descriptionKey` to text; unknown keys fall back to the key itself. */
export function orderValidationText(key: string, language: OrderValidationLanguage): string {
  const match = KEY_PATTERN.exec(key);
  if (match === null) return key;
  const copy = orderValidationLocalization[language][match[1] as OrderValidationCopyKey] as
    Copy | undefined;
  if (copy === undefined) return key;
  return match[2] === "title" ? copy.title : copy.description;
}
