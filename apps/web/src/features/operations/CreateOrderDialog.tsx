import { type FormEvent, useCallback, useContext, useEffect, useRef, useState } from "react";
import { UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import type {
  CompanyArea,
  CustomerOption,
  OperationsDriver,
  OperationsOrder,
  OperationsOrderQuote,
  OperationsTraderOption,
  SearchPage,
} from "../../api/contracts.js";
import { Modal } from "../../components/Modal.js";
import { isUaeMobile } from "../../domain/uae-mobile.js";
import { SearchCombobox } from "../../components/SearchCombobox.js";
import { AreaSelector } from "../configuration/AreaSelector.js";
import { PricingDialog, TraderForm } from "../configuration/TraderConfigurationWorkspace.js";
import { CompanyBrandingContext } from "../../app/CompanyBrandingContext.js";
import { formatCurrency } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";
import { localizeName } from "../../localization/localize-name.js";
import { parseMoneyInput, parseNumericInput } from "../../utils/numeric-input.js";

export function CreateOrderDialog({
  api,
  drivers,
  onClose,
  onSaved,
  permissions = [],
  searchDebounceMs,
}: {
  api: ApiClient;
  drivers: readonly OperationsDriver[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  permissions?: readonly string[];
  /** Test seam only: removes the real-time search debounce. Production uses the default. */
  searchDebounceMs?: number;
}) {
  const { i18n, t } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage);
  // Bilingual business data (Trader/Emirate/Area names) follows the user's
  // Search-and-Display preference, independent of the UI language.
  const branding = useContext(CompanyBrandingContext);
  const textLanguage = branding?.textLanguage ?? locale;
  const canCreateArea = permissions.includes("users_roles.manage");
  const canManageTraders = permissions.includes("users_roles.manage");
  const canOverrideFee = permissions.includes("orders.override_service_fee");
  const [trader, setTrader] = useState<OperationsTraderOption>();
  const [customer, setCustomer] = useState<CustomerOption>();
  const [customerAddresses, setCustomerAddresses] = useState<readonly Record<string, unknown>[]>(
    [],
  );
  const [area, setArea] = useState<CompanyArea>();
  const [driverId, setDriverId] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [mobile, setMobile] = useState("");
  const [secondMobile, setSecondMobile] = useState("");
  const [address, setAddress] = useState("");
  const [codAmount, setCodAmount] = useState("0.00");
  const [additionalFees, setAdditionalFees] = useState("0.00");
  const [packageCount, setPackageCount] = useState("1");
  const [notes, setNotes] = useState("");
  const [customerDeliveryNotes, setCustomerDeliveryNotes] = useState("");
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [overrideFee, setOverrideFee] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  // Manual pricing for Traders with no configured price for this Emirate/Area:
  // the operator enters a fee and a reason, and the order is priced manually.
  const [manualFee, setManualFee] = useState("");
  const [manualReason, setManualReason] = useState("");
  const [createTraderOpen, setCreateTraderOpen] = useState(false);
  const [createdTrader, setCreatedTrader] = useState<{
    code: string;
    id: string;
    name: string;
  }>();
  const [quote, setQuote] = useState<OperationsOrderQuote>();
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string>();
  const [pricingMissing, setPricingMissing] = useState(false);
  /* A deliberate free delivery. Kept as its own state rather than inferred from
     a zero COD and a zero fee: those two numbers also describe a pricing gap,
     and the operator's intent is what the backend stores and audits. */
  const [isFreeOrder, setIsFreeOrder] = useState(false);
  const [orderType, setOrderType] = useState<"collect_order" | "delivery">("delivery");
  const [freeOrderReason, setFreeOrderReason] = useState("");
  // Inline "add pricing": create a reusable trader service price for this
  // Emirate/Area instead of pricing the single order manually.
  const [addPricingOpen, setAddPricingOpen] = useState(false);
  const [pricingScope, setPricingScope] = useState<"area" | "emirate" | "global">("area");
  const [pricingFee, setPricingFee] = useState("");
  const [pricingReason, setPricingReason] = useState("");
  const [pricingSaving, setPricingSaving] = useState(false);
  const [pricingError, setPricingError] = useState<string>();
  const [requoteNonce, setRequoteNonce] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [createdOrder, setCreatedOrder] = useState<OperationsOrder>();
  const [identifierError, setIdentifierError] = useState<string>();
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [fieldErrorOverrides, setFieldErrorOverrides] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const submittingRef = useRef(false);
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  // Mobile format is advisory on the Order form: a value that is not a
  // recognisable UAE mobile is flagged as a recommendation, not an error, and
  // never blocks Order creation. Only an empty Primary Mobile blocks.
  const mobileAdvisory = mobile.trim() !== "" && !isUaeMobile(mobile);
  const secondMobileAdvisory = secondMobile.trim() !== "" && !isUaeMobile(secondMobile);
  const codInput = parseMoneyInput(codAmount, { required: true });
  const additionalFeesInput = parseMoneyInput(additionalFees, { required: true });
  const packageCountInput = parseNumericInput(packageCount, {
    maxAbsolute: 1_000_000,
    required: true,
    wholeNumber: true,
  });
  const overrideFeeInput = parseMoneyInput(overrideFee, { required: true });
  const manualFeeInput = parseMoneyInput(manualFee, { required: true });
  const pricingFeeInput = parseMoneyInput(pricingFee, { required: true });
  const overrideValid =
    !overrideEnabled || (overrideFee !== "" && overrideFeeInput.ok && overrideReason.trim() !== "");

  // One fee-entry path: an operator either overrides a configured price, or
  // enters a manual price when none is configured. Both send serviceFee + reason.
  const overriding = overrideEnabled && canOverrideFee;
  const feeInput = overriding ? overrideFee : manualFee;
  const reasonInput = overriding ? overrideReason : manualReason;
  const parsedFee = parseMoneyInput(feeInput, { required: true });
  const enteredFee = feeInput.trim() === "" || !parsedFee.ok ? undefined : parsedFee.value;
  const enteredReason = reasonInput.trim() === "" ? undefined : reasonInput.trim();
  // Ordered field keys used by the validation summary, focus management and the
  // aria wiring. The order follows the visual reading order of the form.
  const fieldOrder = [
    "serialNumber",
    "trader",
    "customer",
    "customerName",
    "mobile",
    "secondMobile",
    "area",
    "address",
    "codAmount",
    "additionalFees",
    "packageCount",
    "freeOrderReason",
    "pricing",
    "overrideFee",
    "overrideReason",
  ] as const;

  // Structured field errors replace the single boolean gate: the Create Order
  // button stays enabled and a full validation runs on submit, so the operator
  // always sees exactly what is missing or invalid.
  const validationErrors: Record<string, string> = {};
  if (serialNumber.trim() === "")
    validationErrors.serialNumber = t("operations.errors.serialRequired");
  else if (identifierError !== undefined) validationErrors.serialNumber = identifierError;
  if (trader === undefined) validationErrors.trader = t("operations.errors.traderRequired");
  // A Customer is captured by typing a Name directly (new) or selecting a saved
  // one; either way the Name must be present. No separate "select a Customer"
  // gate and no UAE mobile-format gate — those are handled inline/advisory.
  if (
    area === undefined &&
    (orderType !== "collect_order" || customerName.trim() !== "" || mobile.trim() !== "")
  )
    validationErrors.area = t("operations.errors.areaRequired");
  /* Address is optional on every path. A NEW Customer captured without one gets
     no saved address record at all, rather than a placeholder -- so there is no
     longer an inline-create case that needs to ask for it. */
  if (!codInput.ok) validationErrors.codAmount = t("operations.errors.codInvalid");
  if (!additionalFeesInput.ok)
    validationErrors.additionalFees = t("operations.errors.additionalInvalid");
  if (!packageCountInput.ok || packageCountInput.value < 1)
    validationErrors.packageCount = t("operations.errors.packagesInvalid");
  if (isFreeOrder || orderType === "collect_order") {
    /* Pricing is deliberately NOT validated here. A Free Order is an intentional
       override, not a missing-pricing failure, so an unpriced Trader/Area must
       not block it -- that blocker is exactly the problem this feature removes.
       The backend skips resolution for the same reason. */
    if (isFreeOrder && freeOrderReason.trim() === "")
      validationErrors.freeOrderReason = t("operations.errors.freeOrderReasonRequired");
  } else if (pricingMissing) {
    if (!(manualFee !== "" && manualFeeInput.ok))
      validationErrors.pricing = t("operations.errors.manualFeeRequired");
  } else if (quote === undefined || quoteError !== undefined) {
    validationErrors.pricing = t("operations.errors.pricingUnresolved");
  }
  if (overrideEnabled) {
    if (!(overrideFee !== "" && overrideFeeInput.ok))
      validationErrors.overrideFee = t("operations.errors.overrideFeeInvalid");
    if (overrideReason.trim() === "")
      validationErrors.overrideReason = t("operations.errors.overrideReasonRequired");
  }
  // Server-mapped errors (from a failed submission) show alongside client-side
  // ones; a fresh client-side error for the same field wins, and server errors
  // are cleared when the user edits that field.
  const errors: Record<string, string> = { ...fieldErrorOverrides, ...validationErrors };
  const showErrors = submitAttempted || Object.keys(fieldErrorOverrides).length > 0;
  const orderedErrorKeys = fieldOrder.filter((key) => errors[key] !== undefined);

  const focusFieldSelectors: Record<string, string> = {
    address: "#order-address",
    additionalFees: "#order-additional",
    area: '[data-field="area"] select, [data-field="area"] input',
    codAmount: "#order-cod",
    freeOrderReason: "#order-free-reason",
    customer: '[data-field="customer"] input',
    customerName: '[data-field="customer"] input',
    mobile: "#order-mobile",
    overrideFee: "#order-override-fee",
    overrideReason: "#order-override-reason",
    packageCount: "#order-packages",
    pricing: "#order-manual-fee",
    secondMobile: "#order-second-mobile",
    serialNumber: "#order-serial",
    trader: '[data-field="trader"] input',
  };
  const focusField = (key: string) => {
    const selector = focusFieldSelectors[key];
    const element = selector
      ? (formRef.current?.querySelector<HTMLElement>(selector) ?? undefined)
      : undefined;
    element?.focus();
    element?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  };
  const errorFor = (key: string): string | undefined => (showErrors ? errors[key] : undefined);
  const describedBy = (key: string): string | undefined =>
    errorFor(key) === undefined ? undefined : `order-${key}-error`;
  const clearServerError = (key: string) =>
    setFieldErrorOverrides((current) => {
      if (current[key] === undefined) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  const dirty =
    trader !== undefined ||
    area !== undefined ||
    [
      driverId,
      serialNumber,
      referenceNumber,
      customerName,
      mobile,
      secondMobile,
      address,
      notes,
    ].some(Boolean) ||
    codAmount !== "0.00" ||
    additionalFees !== "0.00" ||
    packageCount !== "1";

  // Trader results show the name in the Search-and-Display language plus mobile
  // and pickup Area to distinguish duplicates; the internal code is never shown.
  const traderLabel = useCallback(
    (option: OperationsTraderOption) => {
      const parts = [localizeName(textLanguage, { ar: option.nameAr, en: option.nameEn })];
      if (option.mobileNumber) parts.push(option.mobileNumber);
      const areaName = localizeName(textLanguage, {
        ar: option.pickupAreaNameAr,
        en: option.pickupAreaNameEn,
      });
      if (areaName !== "") parts.push(areaName);
      return parts.filter(Boolean).join(" · ");
    },
    [textLanguage],
  );
  const traderSelectedLabel = useCallback(
    (option: OperationsTraderOption) =>
      localizeName(textLanguage, { ar: option.nameAr, en: option.nameEn }),
    [textLanguage],
  );
  // Customers keep their single stored Name; results add mobile and Area to
  // separate same-named customers. No internal code is shown.
  const customerLabel = useCallback(
    (option: CustomerOption) => {
      const parts = [option.name];
      if (option.mobileNumber) parts.push(option.mobileNumber);
      const areaName = localizeName(textLanguage, {
        ar: option.areaNameAr,
        en: option.areaName,
      });
      if (areaName !== "") parts.push(areaName);
      return parts.filter(Boolean).join(" · ");
    },
    [textLanguage],
  );
  const customerSelectedLabel = useCallback((option: CustomerOption) => option.name, []);
  const applyCustomer = useCallback((option: CustomerOption) => {
    setCustomer(option);
    setCustomerName(option.name);
    setMobile(option.mobileNumber);
    setSecondMobile(option.secondMobileNumber ?? "");
    setAddress(option.address);
    setCustomerDeliveryNotes(option.deliveryInstructions ?? option.deliveryNotes ?? "");
    setArea({
      code: option.areaCode,
      emirateCode: "",
      emirateId: option.emirateId,
      emirateNameAr: option.emirateNameAr,
      emirateNameEn: option.emirateNameEn,
      id: option.areaId,
      isActive: true,
      nameAr: option.areaNameAr,
      nameEn: option.areaName,
      notes: null,
      updatedAt: "",
    });
  }, []);

  const selectCreatedTrader = useCallback(
    async (created: { code: string; id: string; name: string }) => {
      const page = await api.get<SearchPage<OperationsTraderOption>>(
        `operations/traders/search?search=${encodeURIComponent(created.code)}&limit=10&offset=0`,
      );
      const option = page.items.find((item) => item.id === created.id) ?? page.items[0];
      if (option !== undefined) {
        setTrader(option);
        setOverrideEnabled(false);
        clearServerError("trader");
      }
    },
    [api],
  );

  useEffect(() => {
    let active = true;
    void api
      .get<{ serialNumber: string }>("operations/orders/next-serial-number")
      .then((result) => {
        if (!active) return;
        setSerialNumber((current) => (current.trim() === "" ? result.serialNumber : current));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    setIdentifierError(undefined);
    if (serialNumber.trim() === "") return;
    let active = true;
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ serialNumber: serialNumber.trim() });
      if (referenceNumber.trim() !== "") {
        query.set("referenceNumber", referenceNumber.trim());
      }
      void api
        .get<{ referenceNumberAvailable: boolean; serialNumberAvailable: boolean }>(
          `operations/orders/identifier-availability?${query.toString()}`,
        )
        .then((availability) => {
          if (!active) return;
          if (!availability.serialNumberAvailable) {
            setIdentifierError(t("operations.serialNumberExists"));
          } else if (!availability.referenceNumberAvailable) {
            setIdentifierError(t("operations.referenceNumberExists"));
          }
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, referenceNumber, serialNumber, t]);

  useEffect(() => {
    setQuote(undefined);
    setQuoteError(undefined);
    // A Free Order is an approved business decision, not a pricing request.
    // Stop any pending quote state immediately so it cannot disable submission
    // or reintroduce an unresolved-pricing validation error.
    if (isFreeOrder || orderType === "collect_order") {
      setQuoteLoading(false);
      return;
    }
    if (
      trader === undefined ||
      area === undefined ||
      !codInput.ok ||
      !additionalFeesInput.ok ||
      !overrideValid
    )
      return;
    let active = true;
    const timer = window.setTimeout(() => {
      setQuoteLoading(true);
      void api
        .post<OperationsOrderQuote>("operations/orders/quote", {
          areaId: area.id,
          additionalFees: additionalFeesInput.value,
          codAmount: codInput.value,
          driverId: driverId || undefined,
          serviceFee: enteredFee,
          serviceFeeOverrideReason: enteredReason,
          traderId: trader.id,
        })
        .then((result) => {
          if (!active) return;
          setQuote(result);
          setQuoteError(undefined);
          // Deliberately does NOT clear pricingMissing: once this Trader/Area is
          // known to have no configured price, the manual-fee field stays
          // visible so the operator can still adjust it. It resets only when the
          // Trader or Area changes.
        })
        .catch((requestError: unknown) => {
          if (!active) return;
          setQuote(undefined);
          const code = requestError instanceof ApiError ? requestError.code : undefined;
          if (code === "pricing_not_configured") setPricingMissing(true);
          setQuoteError(
            code === "pricing_not_configured"
              ? t("operations.pricingNotConfigured")
              : requestError instanceof Error
                ? requestError.message
                : t("operations.quoteFailed"),
          );
        })
        .finally(() => active && setQuoteLoading(false));
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [
    api,
    area,
    additionalFees,
    codAmount,
    driverId,
    enteredFee,
    enteredReason,
    isFreeOrder,
    orderType,
    overrideValid,
    requoteNonce,
    t,
    trader,
  ]);

  // A new Trader or Area is a fresh pricing context: forget any manual price
  // and close the inline pricing editor.
  useEffect(() => {
    setPricingMissing(false);
    setManualFee("");
    setManualReason("");
    setAddPricingOpen(false);
    setPricingFee("");
    setPricingReason("");
    setPricingError(undefined);
  }, [trader, area]);

  const hasEmirate = Boolean(area?.emirateId);
  // Creates a reusable trader service price for the chosen scope, then re-quotes so
  // the order picks up the configured price instead of a one-off manual fee.
  const savePricing = async () => {
    if (trader === undefined || area === undefined || pricingFee === "" || !pricingFeeInput.ok) {
      return;
    }
    setPricingSaving(true);
    setPricingError(undefined);
    try {
      const payload: Record<string, unknown> = {
        reason: pricingReason.trim() || undefined,
        serviceFee: pricingFeeInput.value,
      };
      if (pricingScope === "area") {
        payload.emirateId = area.emirateId;
        payload.areaId = area.id;
      } else if (pricingScope === "emirate") {
        payload.emirateId = area.emirateId;
      }
      await api.post(`configuration/traders/${trader.id}/pricing`, payload);
      setAddPricingOpen(false);
      setPricingFee("");
      setPricingReason("");
      setManualFee("");
      setManualReason("");
      setPricingMissing(false);
      setRequoteNonce((nonce) => nonce + 1);
    } catch (requestError) {
      setPricingError(
        requestError instanceof ApiError || requestError instanceof Error
          ? requestError.message
          : t("operations.pricingSaveFailed"),
      );
    } finally {
      setPricingSaving(false);
    }
  };

  const requestClose = useCallback(() => {
    if (createdOrder === undefined && dirty && !window.confirm(t("operations.discardOrderChanges")))
      return;
    onClose();
  }, [createdOrder, dirty, onClose, t]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitAttempted(true);
    const firstError = fieldOrder.find((key) => validationErrors[key] !== undefined);
    if (firstError !== undefined) {
      setError(t("operations.errors.summaryHeading"));
      focusField(firstError);
      return;
    }
    if (submittingRef.current || trader === undefined) return;
    submittingRef.current = true;
    setSaving(true);
    setError(undefined);
    setFieldErrorOverrides({});
    try {
      const order = await api.post<OperationsOrder>(
        "operations/orders",
        {
          additionalFees:
            isFreeOrder || orderType === "collect_order"
              ? 0
              : additionalFeesInput.ok
                ? additionalFeesInput.value
                : 0,
          ...(area === undefined ? {} : { areaId: area.id }),
          codAmount:
            isFreeOrder || orderType === "collect_order" ? 0 : codInput.ok ? codInput.value : 0,
          // The backend forces both to zero regardless; sending them honestly
          // keeps the request readable in a network log.
          isFreeOrder,
          orderType,
          ...(isFreeOrder ? { freeOrderReason: freeOrderReason.trim() } : {}),
          customerAddress: address.trim(),
          customerAddressId: customer?.addressId,
          customerDeliveryNotes: customerDeliveryNotes.trim() || undefined,
          customerId: customer?.id,
          customerLatitude: customer?.latitude == null ? undefined : Number(customer.latitude),
          customerLocationLink: customer?.locationLink ?? undefined,
          customerLongitude: customer?.longitude == null ? undefined : Number(customer.longitude),
          // Mobile is sent exactly as typed (trimmed only). The API normalizes
          // recognisable UAE forms; it is not forced to a canonical shape here.
          ...(customerName.trim() === "" ? {} : { customerName: customerName.trim() }),
          ...(mobile.trim() === "" ? {} : { customerMobileNumber: mobile.trim() }),
          customerSecondMobileNumber: secondMobile.trim() === "" ? undefined : secondMobile.trim(),
          ...(orderType === "collect_order" || driverId === "" ? {} : { driverId }),
          notes: notes.trim() || undefined,
          packageCount: packageCountInput.ok ? packageCountInput.value : 0,
          referenceNumber: referenceNumber.trim() || undefined,
          serialNumber: serialNumber.trim(),
          serviceFee: enteredFee,
          serviceFeeOverrideReason: enteredReason,
          traderId: trader.id,
          // No existing Customer selected: create one atomically from the typed
          // Order details in the same transaction (no separate modal, no orphan).
          ...(customer !== undefined || customerName.trim() === "" || mobile.trim() === ""
            ? {}
            : {
                inlineCustomer: {
                  address: address.trim(),
                  areaId: area!.id,
                  mobileNumber: mobile.trim(),
                  name: customerName.trim(),
                  ...(secondMobile.trim() === ""
                    ? {}
                    : { secondMobileNumber: secondMobile.trim() }),
                },
              }),
        },
        { "X-Idempotency-Key": idempotencyKeyRef.current },
      );
      setCreatedOrder(order);
      await onSaved();
    } catch (requestError) {
      const code = requestError instanceof ApiError ? requestError.code : undefined;
      // Map backend error codes to the field the operator can act on, so the
      // failure is shown next to that field rather than as an opaque banner.
      const fieldForCode: Record<string, { field: string; message: string }> = {
        area_not_found: { field: "area", message: t("operations.errors.areaNotFound") },
        customer_address_not_found: {
          field: "customer",
          message: t("operations.errors.customerInvalid"),
        },
        customer_area_mismatch: { field: "area", message: t("operations.errors.areaMismatch") },
        customer_duplicate: {
          field: "customer",
          message: t("operations.errors.customerDuplicate"),
        },
        customer_not_found: { field: "customer", message: t("operations.errors.customerInvalid") },
        order_customer_selection_invalid: {
          field: "customer",
          message: t("operations.errors.customerRequired"),
        },
        order_deductions_exceed_cod: {
          field: "codAmount",
          message: t("operations.errors.deductionsExceedCod"),
        },
        order_identifier_invalid: {
          field: "serialNumber",
          message: t("operations.errors.serialInvalid"),
        },
        pricing_not_configured: {
          field: "pricing",
          message: t("operations.pricingNotConfigured"),
        },
        reference_number_exists: {
          field: "serialNumber",
          message: t("operations.referenceNumberExists"),
        },
        serial_number_exists: {
          field: "serialNumber",
          message: t("operations.serialNumberExists"),
        },
        order_serial_already_exists_for_date: {
          field: "serialNumber",
          message: t("operations.serialNumberExistsForDate"),
        },
        service_fee_override_denied: {
          field: "overrideReason",
          message: t("operations.errors.overrideDenied"),
        },
        service_fee_override_reason_required: {
          field: "overrideReason",
          message: t("operations.errors.overrideReasonRequired"),
        },
        trader_not_found: { field: "trader", message: t("operations.errors.traderInvalid") },
      };
      const mapped = code === undefined ? undefined : fieldForCode[code];
      if (mapped !== undefined) {
        setFieldErrorOverrides({ [mapped.field]: mapped.message });
        setSubmitAttempted(true);
        setError(t("operations.errors.summaryHeading"));
        focusField(mapped.field);
      } else if (code === "invalid_session" || code === "authentication_required") {
        setError(t("operations.errors.sessionExpired"));
      } else if (code === "permission_denied" || code === "identity_kind_denied") {
        setError(t("operations.errors.permissionDenied"));
      } else {
        // A safe, human-readable fallback; raw database/stack detail is never
        // surfaced (the server already returns a sanitized message).
        setError(
          requestError instanceof Error ? requestError.message : t("operations.createOrderFailed"),
        );
      }
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  };

  const money = (value: string | undefined) => formatCurrency(value ?? "0", "AED", locale);
  const negativeTraderPayable = quote !== undefined && Number(quote.traderNetPayable) < 0;

  return (
    <>
      <Modal
        className="order-modal"
        closeLabel={t("common.close")}
        onRequestClose={requestClose}
        title={t("operations.createOrder")}
        titleId="create-order-title"
      >
        {createdOrder === undefined ? (
          <form
            className="order-form"
            noValidate
            onSubmit={(event) => void submit(event)}
            ref={formRef}
          >
            <div className="order-modal-scroll">
              <div className="order-form-columns">
                <section className="order-form-group" aria-labelledby="order-customer-heading">
                  <div className="form-section-heading">
                    <span aria-hidden="true">01</span>
                    <h3 id="order-customer-heading">{t("operations.orderCustomerInfo")}</h3>
                  </div>
                  <div className="form-grid">
                    <label
                      className={orderType === "collect_order" ? "field" : "field required-field"}
                    >
                      <span>{t("operations.serialNumber")}</span>
                      <input
                        aria-describedby={describedBy("serialNumber")}
                        aria-invalid={errorFor("serialNumber") !== undefined}
                        autoComplete="off"
                        id="order-serial"
                        maxLength={100}
                        onChange={(event) => {
                          setSerialNumber(event.target.value);
                          clearServerError("serialNumber");
                        }}
                        required
                        value={serialNumber}
                      />
                    </label>
                    <label className="field">
                      <span>{t("operations.referenceNumber")}</span>
                      <input
                        aria-invalid={identifierError !== undefined}
                        autoComplete="off"
                        maxLength={100}
                        onChange={(event) => setReferenceNumber(event.target.value)}
                        value={referenceNumber}
                      />
                    </label>
                  </div>
                  {errorFor("serialNumber") === undefined ? null : (
                    <small className="field-error" id="order-serialNumber-error" role="alert">
                      {errorFor("serialNumber")}
                    </small>
                  )}
                  <label className="field required-field">
                    <span>{t("operations.trader")}</span>
                    <div className="input-with-action" data-field="trader">
                      <SearchCombobox
                        {...(searchDebounceMs === undefined
                          ? {}
                          : { debounceMs: searchDebounceMs })}
                        api={api}
                        autoFocus
                        emptyText={t("operations.noTradersFound")}
                        getLabel={traderLabel}
                        getSelectedLabel={traderSelectedLabel}
                        label={t("operations.trader")}
                        onChange={(selected) => {
                          setTrader(selected);
                          setOverrideEnabled(false);
                          clearServerError("trader");
                        }}
                        path="operations/traders/search"
                        placeholder={t("operations.searchTrader")}
                        value={trader}
                      />
                      {canManageTraders ? (
                        <button
                          aria-label={t("operations.addTrader")}
                          className="icon-button"
                          onClick={() => {
                            setCreatedTrader(undefined);
                            setCreateTraderOpen(true);
                          }}
                          title={t("operations.addTrader")}
                          type="button"
                        >
                          <UserPlus size={18} />
                        </button>
                      ) : null}
                    </div>
                    {errorFor("trader") === undefined ? null : (
                      <small className="field-error" id="order-trader-error" role="alert">
                        {errorFor("trader")}
                      </small>
                    )}
                  </label>
                  <label className="field">
                    <span>{t("operations.customerName")}</span>
                    <div data-field="customer">
                      <SearchCombobox
                        {...(searchDebounceMs === undefined
                          ? {}
                          : { debounceMs: searchDebounceMs })}
                        api={api}
                        emptyText={t("customerConfig.noCustomers")}
                        getLabel={customerLabel}
                        getSelectedLabel={customerSelectedLabel}
                        label={t("operations.customerName")}
                        onChange={(selected) => {
                          clearServerError("customer");
                          if (selected) {
                            applyCustomer(selected);
                            void api
                              .get<{ addresses: readonly Record<string, unknown>[] }>(
                                `configuration/customers/${encodeURIComponent(selected.code)}`,
                              )
                              .then((detail) => setCustomerAddresses(detail.addresses));
                          } else {
                            // No suggestion chosen: the typed text is the new
                            // Customer's Name (kept via onQueryChange), so only
                            // the existing-Customer link is released here.
                            setCustomer(undefined);
                            setCustomerAddresses([]);
                          }
                        }}
                        onQueryChange={(query) => {
                          setCustomerName(query);
                          clearServerError("customerName");
                        }}
                        path="configuration/customers/search"
                        placeholder={t("operations.customerSearchOrType")}
                        required={false}
                        value={customer}
                      />
                    </div>
                    <small className="field-hint">{t("operations.customerFieldHint")}</small>
                    {errorFor("customerName") !== undefined ? (
                      <small className="field-error" id="order-customerName-error" role="alert">
                        {errorFor("customerName")}
                      </small>
                    ) : errorFor("customer") === undefined ? null : (
                      <small className="field-error" id="order-customer-error" role="alert">
                        {errorFor("customer")}
                      </small>
                    )}
                  </label>
                  {customer !== undefined && customerAddresses.length > 1 ? (
                    <label className="field">
                      <span>{t("customerConfig.addresses")}</span>
                      <select
                        onChange={(event) => {
                          const selectedAddress = customerAddresses.find(
                            (item) => String(item.id) === event.target.value,
                          );
                          if (selectedAddress === undefined) return;
                          const nextCustomer: CustomerOption = {
                            ...customer,
                            address: String(selectedAddress.address),
                            addressId: String(selectedAddress.id),
                            areaCode: String(selectedAddress.areaCode),
                            areaId: String(selectedAddress.areaId),
                            areaName: String(selectedAddress.areaName),
                            deliveryInstructions:
                              selectedAddress.deliveryInstructions === null
                                ? null
                                : String(selectedAddress.deliveryInstructions),
                            latitude:
                              selectedAddress.latitude === null
                                ? null
                                : String(selectedAddress.latitude),
                            locationLink:
                              selectedAddress.locationLink === null
                                ? null
                                : String(selectedAddress.locationLink),
                            longitude:
                              selectedAddress.longitude === null
                                ? null
                                : String(selectedAddress.longitude),
                          };
                          applyCustomer(nextCustomer);
                        }}
                        value={customer.addressId}
                      >
                        {customerAddresses
                          .filter((item) => Boolean(item.isActive))
                          .map((item) => (
                            <option key={String(item.id)} value={String(item.id)}>
                              {String(item.label ?? item.address)}
                            </option>
                          ))}
                      </select>
                    </label>
                  ) : null}
                  <div className="form-grid">
                    <label className="field">
                      <span>{t("operations.mobile")}</span>
                      <input
                        aria-describedby={
                          errorFor("mobile") !== undefined
                            ? "order-mobile-error"
                            : mobileAdvisory
                              ? "order-mobile-advisory"
                              : undefined
                        }
                        aria-invalid={errorFor("mobile") !== undefined}
                        autoComplete="tel"
                        id="order-mobile"
                        inputMode="tel"
                        maxLength={32}
                        onChange={(event) => {
                          setMobile(event.target.value);
                          clearServerError("mobile");
                        }}
                        placeholder={t("common.mobilePlaceholder")}
                        required={false}
                        value={mobile}
                      />
                      {errorFor("mobile") !== undefined ? (
                        <small className="field-error" id="order-mobile-error">
                          {errorFor("mobile")}
                        </small>
                      ) : mobileAdvisory ? (
                        <small className="field-advisory" id="order-mobile-advisory">
                          {t("operations.mobileAdvisory")}
                        </small>
                      ) : null}
                    </label>
                    <label className="field">
                      <span>{t("operations.secondMobile")}</span>
                      <input
                        aria-describedby={
                          secondMobileAdvisory ? "order-secondMobile-advisory" : undefined
                        }
                        autoComplete="tel"
                        id="order-second-mobile"
                        inputMode="tel"
                        maxLength={32}
                        onChange={(event) => {
                          setSecondMobile(event.target.value);
                          clearServerError("secondMobile");
                        }}
                        placeholder={t("common.mobilePlaceholder")}
                        value={secondMobile}
                      />
                      {errorFor("secondMobile") !== undefined ? (
                        <small className="field-error" id="order-secondMobile-error">
                          {errorFor("secondMobile")}
                        </small>
                      ) : secondMobileAdvisory ? (
                        <small className="field-advisory" id="order-secondMobile-advisory">
                          {t("operations.mobileAdvisory")}
                        </small>
                      ) : null}
                    </label>
                  </div>
                  <div
                    className={orderType === "collect_order" ? "field" : "required-field"}
                    data-field="area"
                  >
                    <AreaSelector
                      allowCreate={canCreateArea && customer === undefined}
                      api={api}
                      disabled={customer !== undefined}
                      onChange={(selected) => {
                        setArea(selected);
                        setOverrideEnabled(false);
                        clearServerError("area");
                      }}
                      {...(searchDebounceMs === undefined ? {} : { searchDebounceMs })}
                      required={orderType !== "collect_order"}
                      value={area}
                    />
                    {errorFor("area") === undefined ? null : (
                      <small className="field-error" id="order-area-error" role="alert">
                        {errorFor("area")}
                      </small>
                    )}
                  </div>
                  {/* Optional on every path -- never marked required. */}
                  <label className="field field-grow">
                    <span>{t("operations.customerAddress")}</span>
                    <textarea
                      aria-describedby={describedBy("address")}
                      aria-invalid={errorFor("address") !== undefined}
                      id="order-address"
                      maxLength={500}
                      onChange={(event) => setAddress(event.target.value)}
                      rows={3}
                      value={address}
                    />
                    {errorFor("address") === undefined ? null : (
                      <small className="field-error" id="order-address-error">
                        {errorFor("address")}
                      </small>
                    )}
                  </label>
                  <label className="field field-grow">
                    <span>{t("customerConfig.deliveryInstructions")}</span>
                    <textarea
                      maxLength={1000}
                      onChange={(event) => setCustomerDeliveryNotes(event.target.value)}
                      rows={2}
                      value={customerDeliveryNotes}
                    />
                  </label>
                </section>
                <section className="order-form-group" aria-labelledby="delivery-financial-heading">
                  <div className="form-section-heading">
                    <span aria-hidden="true">02</span>
                    <h3 id="delivery-financial-heading">{t("operations.deliveryFinancialInfo")}</h3>
                  </div>
                  <div className="form-grid">
                    <label className="field">
                      <span>{t("operations.orderType")}</span>
                      <select
                        value={orderType}
                        onChange={(event) => {
                          const next = event.target.value as "collect_order" | "delivery";
                          setOrderType(next);
                          if (next === "collect_order") {
                            setDriverId("");
                            setIsFreeOrder(false);
                            setFreeOrderReason("");
                            setCodAmount("0.00");
                            setAdditionalFees("0.00");
                            setPricingMissing(false);
                            setQuoteError(undefined);
                          }
                        }}
                      >
                        <option value="delivery">{t("operations.internalDelivery")}</option>
                        <option value="collect_order">{t("operations.collectOrder")}</option>
                      </select>
                    </label>
                    <div className="field">
                      <span>
                        {orderType === "collect_order"
                          ? t("operations.financialHandling")
                          : t("operations.paymentCondition")}
                      </span>
                      <strong>
                        {t(
                          orderType === "collect_order"
                            ? "operations.collectOrderFinancialHint"
                            : "operations.customerPaysCod",
                        )}
                      </strong>
                    </div>
                  </div>
                  {orderType === "collect_order" ? null : (
                    <label className="field">
                      <span>{t("operations.assignedDriver")}</span>
                      <select onChange={(event) => setDriverId(event.target.value)} value={driverId}>
                        <option value="">{t("operations.unassigned")}</option>
                        {drivers
                          .filter((driver) => driver.status === "active")
                          .map((driver) => (
                            <option key={driver.id} value={driver.id}>
                              {driver.code} - {driver.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  {/* Sits with the money, because that is what it changes. */}
                  {orderType === "collect_order" ? null : (
                    <div className="field free-order-toggle">
                      <label className="checkbox-row">
                        <input
                          checked={isFreeOrder}
                          id="order-free"
                          onChange={(event) => {
                            const next = event.target.checked;
                            setIsFreeOrder(next);
                            if (next) {
                              // Zero the money immediately so the operator never
                              // types it, and drop the unresolved-pricing blocker:
                              // this Order is priced by decision, not by lookup.
                              setCodAmount("0.00");
                              setAdditionalFees("0.00");
                              setPricingMissing(false);
                              setQuoteError(undefined);
                              setQuoteLoading(false);
                            } else {
                              // Leaving Free clears the reason so it cannot be
                              // submitted on an Order that is no longer free, and
                              // hands pricing back to the normal flow rather than
                              // restoring a stale fee.
                              setFreeOrderReason("");
                              setRequoteNonce((nonce) => nonce + 1);
                            }
                            clearServerError("freeOrderReason");
                          }}
                          type="checkbox"
                        />
                        <span>{t("operations.freeOrder")}</span>
                      </label>
                      {isFreeOrder ? (
                        <>
                          <small className="field-hint">{t("operations.freeOrderHint")}</small>
                          <label className="field required-field">
                            <span>{t("operations.freeOrderReason")}</span>
                            <input
                              aria-describedby={describedBy("freeOrderReason")}
                              aria-invalid={errorFor("freeOrderReason") !== undefined}
                              id="order-free-reason"
                              maxLength={300}
                              onChange={(event) => {
                                setFreeOrderReason(event.target.value);
                                clearServerError("freeOrderReason");
                              }}
                              value={freeOrderReason}
                            />
                            {errorFor("freeOrderReason") === undefined ? null : (
                              <small className="field-error" id="order-freeOrderReason-error">
                                {errorFor("freeOrderReason")}
                              </small>
                            )}
                          </label>
                        </>
                      ) : null}
                    </div>
                  )}
                  <div className="form-grid">
                    <label className="field required-field">
                      <span>{t("operations.codAmount")}</span>
                      <input
                        aria-describedby={describedBy("codAmount")}
                        aria-invalid={errorFor("codAmount") !== undefined}
                        disabled={isFreeOrder || orderType === "collect_order"}
                        id="order-cod"
                        min="0"
                        onChange={(event) => {
                          setCodAmount(event.target.value);
                          clearServerError("codAmount");
                        }}
                        required
                        step="0.01"
                        type="number"
                        value={codAmount}
                      />
                      {errorFor("codAmount") === undefined ? null : (
                        <small className="field-error" id="order-codAmount-error">
                          {errorFor("codAmount")}
                        </small>
                      )}
                    </label>
                    <label className="field">
                      <span>{t("operations.serviceFee")}</span>
                      <input readOnly value={quote?.configuredServiceFee ?? ""} />
                    </label>
                  </div>
                  <label className="field">
                    <span>{t("operations.additionalFees")}</span>
                    <input
                      aria-describedby={describedBy("additionalFees")}
                      aria-invalid={errorFor("additionalFees") !== undefined}
                      id="order-additional"
                      disabled={isFreeOrder || orderType === "collect_order"}
                      min="0"
                      onChange={(event) => setAdditionalFees(event.target.value)}
                      step="0.01"
                      type="number"
                      value={additionalFees}
                    />
                    {errorFor("additionalFees") === undefined ? null : (
                      <small className="field-error" id="order-additionalFees-error">
                        {errorFor("additionalFees")}
                      </small>
                    )}
                  </label>
                  {isFreeOrder || orderType === "collect_order" ? (
                    // No pricing UI at all while Free: nothing to resolve, and
                    // nothing for the operator to override.
                    <div className="fee-override" role="group">
                      <p className="field-hint">
                        {t(
                          orderType === "collect_order"
                            ? "operations.collectOrderFinancialHint"
                            : "operations.freeOrderFeeLocked",
                        )}
                      </p>
                    </div>
                  ) : pricingMissing ? (
                    <div className="fee-override pricing-missing" role="group">
                      <p className="field-hint">{t("operations.pricingFailureMessage")}</p>
                      <div className="pricing-actions">
                        {canCreateArea && !addPricingOpen ? (
                          <button
                            className="button button-secondary"
                            onClick={() => {
                              setPricingScope(hasEmirate ? "area" : "global");
                              setAddPricingOpen(true);
                            }}
                            type="button"
                          >
                            {t("operations.reviewTraderPricing")}
                          </button>
                        ) : null}
                        <button
                          className="button button-secondary"
                          onClick={() => focusField("area")}
                          type="button"
                        >
                          {t("operations.selectAnotherArea")}
                        </button>
                      </div>
                      {addPricingOpen ? (
                        <div className="inline-pricing">
                          <label className="field">
                            <span>{t("operations.pricingScope")}</span>
                            <select
                              onChange={(event) =>
                                setPricingScope(event.target.value as "area" | "emirate" | "global")
                              }
                              value={pricingScope}
                            >
                              {hasEmirate ? (
                                <option value="area">{t("operations.pricingScopeArea")}</option>
                              ) : null}
                              {hasEmirate ? (
                                <option value="emirate">
                                  {t("operations.pricingScopeEmirate")}
                                </option>
                              ) : null}
                              <option value="global">{t("operations.pricingScopeGlobal")}</option>
                            </select>
                          </label>
                          <label className="field required-field">
                            <span>{t("operations.serviceFee")}</span>
                            <input
                              className="no-spinner"
                              inputMode="decimal"
                              min="0"
                              onChange={(event) => setPricingFee(event.target.value)}
                              required
                              step="0.01"
                              type="number"
                              value={pricingFee}
                            />
                          </label>
                          <label className="field">
                            <span>{t("operations.manualFeeReason")}</span>
                            <textarea
                              maxLength={500}
                              onChange={(event) => setPricingReason(event.target.value)}
                              rows={2}
                              value={pricingReason}
                            />
                          </label>
                          {pricingError === undefined ? null : (
                            <div className="alert alert-error">{pricingError}</div>
                          )}
                          <div className="modal-actions">
                            <button
                              className="button button-secondary"
                              onClick={() => setAddPricingOpen(false)}
                              type="button"
                            >
                              {t("common.cancel")}
                            </button>
                            <button
                              className="button button-primary"
                              disabled={pricingSaving || pricingFee === "" || !pricingFeeInput.ok}
                              onClick={() => void savePricing()}
                              type="button"
                            >
                              {pricingSaving ? t("common.saving") : t("operations.savePricing")}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <label className="field required-field">
                            <span>{t("operations.manualServiceFee")}</span>
                            <input
                              aria-describedby={describedBy("pricing")}
                              aria-invalid={errorFor("pricing") !== undefined}
                              className="no-spinner"
                              id="order-manual-fee"
                              inputMode="decimal"
                              min="0"
                              onChange={(event) => setManualFee(event.target.value)}
                              required
                              step="0.01"
                              type="number"
                              value={manualFee}
                            />
                            {errorFor("pricing") === undefined ? null : (
                              <small className="field-error" id="order-pricing-error">
                                {errorFor("pricing")}
                              </small>
                            )}
                          </label>
                          <label className="field">
                            <span>{t("operations.manualFeeReason")}</span>
                            <textarea
                              maxLength={500}
                              onChange={(event) => setManualReason(event.target.value)}
                              rows={2}
                              value={manualReason}
                            />
                          </label>
                        </>
                      )}
                    </div>
                  ) : null}
                  {canOverrideFee && !pricingMissing ? (
                    <div className="fee-override service-fee-override">
                      <label className="checkbox-field">
                        <input
                          checked={overrideEnabled}
                          onChange={(event) => setOverrideEnabled(event.target.checked)}
                          type="checkbox"
                        />
                        <span>{t("operations.overrideServiceFee")}</span>
                      </label>
                      <p className="field-hint">{t("operations.overrideHint")}</p>
                      {overrideEnabled ? (
                        <>
                          <label className="field required-field">
                            <span>{t("operations.overriddenFee")}</span>
                            <input
                              aria-describedby={describedBy("overrideFee")}
                              aria-invalid={errorFor("overrideFee") !== undefined}
                              className="no-spinner"
                              id="order-override-fee"
                              inputMode="decimal"
                              min="0"
                              onChange={(event) => setOverrideFee(event.target.value)}
                              required
                              step="0.01"
                              type="number"
                              value={overrideFee}
                            />
                            {errorFor("overrideFee") === undefined ? null : (
                              <small className="field-error" id="order-overrideFee-error">
                                {errorFor("overrideFee")}
                              </small>
                            )}
                          </label>
                          <label className="field required-field">
                            <span>{t("operations.overrideReason")}</span>
                            <textarea
                              aria-describedby={describedBy("overrideReason")}
                              aria-invalid={errorFor("overrideReason") !== undefined}
                              id="order-override-reason"
                              maxLength={500}
                              onChange={(event) => {
                                setOverrideReason(event.target.value);
                                clearServerError("overrideReason");
                              }}
                              required
                              rows={2}
                              value={overrideReason}
                            />
                            {errorFor("overrideReason") === undefined ? null : (
                              <small className="field-error" id="order-overrideReason-error">
                                {errorFor("overrideReason")}
                              </small>
                            )}
                          </label>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="form-grid">
                    <label className="field required-field">
                      <span>{t("operations.packages")}</span>
                      <input
                        aria-describedby={describedBy("packageCount")}
                        aria-invalid={errorFor("packageCount") !== undefined}
                        className="input-compact"
                        id="order-packages"
                        min="1"
                        onChange={(event) => setPackageCount(event.target.value)}
                        required
                        step="1"
                        type="number"
                        value={packageCount}
                      />
                      {errorFor("packageCount") === undefined ? null : (
                        <small className="field-error" id="order-packageCount-error">
                          {errorFor("packageCount")}
                        </small>
                      )}
                    </label>
                    {/* VAT is only relevant when the Company has it enabled. */}
                    {quote?.vatEnabled ? (
                      <label className="field">
                        <span>{t("operations.vatAmount")}</span>
                        <input readOnly value={quote.vatAmount} />
                      </label>
                    ) : null}
                  </div>
                  <label className="field">
                    <span>{t("operations.notes")}</span>
                    <textarea
                      maxLength={1000}
                      onChange={(event) => setNotes(event.target.value)}
                      rows={3}
                      value={notes}
                    />
                  </label>
                  {orderType === "collect_order" ? null : (
                    <div className="quote-panel" aria-live="polite">
                      {quoteLoading ? (
                        <strong className="quote-loading">{t("operations.pricingLoading")}</strong>
                      ) : quoteError === undefined ? (
                        <>
                          <div>
                            <span>{t("operations.codAmount")}</span>
                            <strong>
                              {money(quote?.codAmount ?? (codInput.ok ? codAmount : "0.00"))}
                            </strong>
                          </div>
                          <div>
                            <span>{t("operations.serviceFee")}</span>
                            <strong>{money(quote?.serviceFee)}</strong>
                          </div>
                          <div>
                            <span>{t("operations.additionalFees")}</span>
                            <strong>{money(quote?.additionalFees)}</strong>
                          </div>
                          {quote?.vatEnabled ? (
                            <div>
                              <span>{t("operations.vatAmount")}</span>
                              <strong>{money(quote.vatAmount)}</strong>
                            </div>
                          ) : null}
                          <div>
                            <span>{t("operations.totalDeductions")}</span>
                            <strong>{money(quote?.totalDeductions)}</strong>
                          </div>
                          <div className={negativeTraderPayable ? "summary-invalid" : undefined}>
                            <span>{t("operations.amountDueToTrader")}</span>
                            <strong>{money(quote?.traderNetPayable)}</strong>
                          </div>
                          <div className="summary-total">
                            <span>{t("operations.totalAmountToCollect")}</span>
                            <strong>{money(quote?.customerAmountDue)}</strong>
                          </div>
                          {negativeTraderPayable ? (
                            <small className="field-error">
                              {t("operations.errors.deductionsExceedCod")}
                            </small>
                          ) : null}
                          {quote?.vatEnabled ? (
                            <small>
                              {t("operations.vatRateApplied", {
                                rate: Number(quote.vatRate).toFixed(2),
                              })}
                            </small>
                          ) : null}
                        </>
                      ) : (
                        <div>
                          <small className="field-error">{quoteError}</small>
                        </div>
                      )}
                    </div>
                  )}
                </section>
              </div>
              {/* Sits at the END of the scrolling body, directly above the action
                  bar, so the failure appears next to the button that caused it
                  rather than a full form-length away at the top. `focusField`
                  still scrolls to the offending field when an item is clicked. */}
              {showErrors && orderedErrorKeys.length > 0 ? (
                <div className="validation-summary" ref={summaryRef} role="alert" tabIndex={-1}>
                  <h3 id="order-validation-heading">{t("operations.errors.summaryHeading")}</h3>
                  <ul>
                    {orderedErrorKeys.map((key) => (
                      <li key={key}>
                        <button
                          className="validation-summary-item"
                          onClick={() => focusField(key)}
                          type="button"
                        >
                          {errors[key]}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : error === undefined ? null : (
                <div className="alert alert-error" role="alert">
                  {error}
                </div>
              )}
            </div>
            <footer className="order-action-bar">
              <div className="order-totals" aria-label={t("operations.orderSummary")}>
                <span className="total-due">
                  <small>{t("operations.totalAmountToCollect")}</small>
                  <strong>{money(quote?.customerAmountDue)}</strong>
                </span>
                <span className={negativeTraderPayable ? "summary-invalid" : undefined}>
                  <small>{t("operations.amountDueToTrader")}</small>
                  <strong>{money(quote?.traderNetPayable)}</strong>
                </span>
              </div>
              <div className="modal-actions order-actions">
                <button className="button button-secondary" onClick={requestClose} type="button">
                  {t("common.cancel")}
                </button>
                <button
                  className="button button-primary"
                  disabled={saving || (!isFreeOrder && quoteLoading)}
                  type="submit"
                >
                  {saving ? t("operations.creatingOrder") : t("operations.createOrder")}
                </button>
              </div>
            </footer>
          </form>
        ) : (
          <div className="order-success" role="status">
            <span className="success-mark" aria-hidden="true">
              OK
            </span>
            <h3>{t("operations.orderCreated")}</h3>
            <small>
              {t("operations.serialNumber")}: {createdOrder.serialNumber}
            </small>
            <button autoFocus className="button button-primary" onClick={onClose} type="button">
              {t("common.done")}
            </button>
          </div>
        )}
      </Modal>
      {createTraderOpen && createdTrader === undefined ? (
        <TraderForm
          api={api}
          onClose={() => setCreateTraderOpen(false)}
          onSaved={(created) => {
            if (created === undefined) return;
            setCreatedTrader({
              code: String(created.code ?? ""),
              id: String(created.id ?? ""),
              name: String(created.name ?? created.nameEn ?? ""),
            });
          }}
          primaryLabel={t("operations.nextSetPricing")}
          title={t("operations.traderInformation")}
        />
      ) : null}
      {createTraderOpen && createdTrader !== undefined ? (
        <PricingDialog
          api={api}
          onClose={() => {
            const created = createdTrader;
            setCreateTraderOpen(false);
            setCreatedTrader(undefined);
            void selectCreatedTrader(created);
          }}
          onSaved={() => {
            const created = createdTrader;
            setCreateTraderOpen(false);
            setCreatedTrader(undefined);
            void selectCreatedTrader(created).then(() => setRequoteNonce((nonce) => nonce + 1));
          }}
          primaryLabel={t("operations.savePricingAndUseTrader")}
          title={t("operations.pricingSetup")}
          trader={createdTrader}
        />
      ) : null}
    </>
  );
}
