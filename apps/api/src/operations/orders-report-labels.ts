/**
 * Orders Report headings and status names, shared by the PDF and the Excel
 * export so both read the same in the same language (Aiman, 27 Oct 2026).
 */
const ARABIC_LABELS = { serial: "م", referenceNumber: "رقم المرجع", orderDate: "تاريخ الطلب", deliveryDate: "تاريخ التسليم", traderName: "اسم التاجر", customer: "العميل", customerMobile: "جوال العميل", emirates: "الإمارة", area: "المنطقة", cod: "الدفع عند الاستلام", amountToCollect: "المطلوب من العميل", fee: "الرسوم", additionalFees: "رسوم إضافية", traderAmount: "مبلغ التاجر", paidToTrader: "مدفوع للتاجر", collectedFromTrader: "محصّل من التاجر", balance: "الرصيد", status: "الحالة" } as const;
const ENGLISH_LABELS = { serial: "No.", referenceNumber: "Reference Number", orderDate: "Order Date", deliveryDate: "Delivery Date", traderName: "Trader Name", customer: "Customer", customerMobile: "Customer Mobile", emirates: "Emirates", area: "Area", cod: "COD", amountToCollect: "Amount to Collect", fee: "Fee", additionalFees: "Additional Fees", traderAmount: "Trader Amount", paidToTrader: "Paid to Trader", collectedFromTrader: "Collected from Trader", balance: "Balance", status: "Status" } as const;

export type OrdersReportLabels = { readonly [K in keyof typeof ENGLISH_LABELS]: string };

export function ordersReportLabels(arabic: boolean): OrdersReportLabels {
  return arabic ? ARABIC_LABELS : ENGLISH_LABELS;
}

const ARABIC_STATUSES: Readonly<Record<string, string>> = { new: "جديد", in_branch: "الصنف في الفرع", assigned_to_driver: "معين للمندوب", out_for_delivery: "خرج للتوصيل", hold: "معلّق", delivered: "تم التسليم", returned_to_branch: "عاد إلى الفرع", returned_to_trader: "عاد إلى التاجر", cancelled: "ملغى", closed: "مغلق", collect_order: "احضار طلب" };
const ENGLISH_STATUSES: Readonly<Record<string, string>> = { new: "New", in_branch: "Item in branch", assigned_to_driver: "Assigned to driver", out_for_delivery: "Out for delivery", hold: "Hold", delivered: "Delivered", returned_to_branch: "Returned to branch", returned_to_trader: "Returned to trader", cancelled: "Cancelled", closed: "Closed", collect_order: "Collect Order" };

export function ordersReportStatusLabels(arabic: boolean): Readonly<Record<string, string>> {
  return arabic ? ARABIC_STATUSES : ENGLISH_STATUSES;
}
