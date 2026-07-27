import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
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
import { isUaeMobile, normalizeUaeMobile } from "../../domain/uae-mobile.js";
import { SearchCombobox } from "../../components/SearchCombobox.js";
import { AreaSelector } from "../configuration/AreaSelector.js";
import { TraderForm } from "../configuration/TraderConfigurationWorkspace.js";
import { formatCurrency } from "../../localization/formatters.js";
import { normalizeLocale } from "../../localization/locale.js";

interface InlineCustomerDraft {
  readonly address: string;
  readonly area: CompanyArea;
  readonly mobileNumber: string;
  readonly name: string;
  readonly secondMobileNumber?: string | undefined;
}

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
  const canCreateArea = permissions.includes("users_roles.manage");
  const canOverrideFee = permissions.includes("orders.override_service_fee");
  const [trader, setTrader] = useState<OperationsTraderOption>();
  const [customer, setCustomer] = useState<CustomerOption>();
  const [inlineCustomer, setInlineCustomer] = useState<InlineCustomerDraft>();
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
  const [createCustomerOpen, setCreateCustomerOpen] = useState(false);
  const [createTraderOpen, setCreateTraderOpen] = useState(false);
  const [quote, setQuote] = useState<OperationsOrderQuote>();
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string>();
  const [pricingMissing, setPricingMissing] = useState(false);
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
  const submittingRef = useRef(false);
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  // Accept 0506468442, 9715XXXXXXXX or +9715XXXXXXXX; normalized on submit.
  const phoneValid = isUaeMobile(mobile);
  const secondPhoneValid = secondMobile.trim() === "" || isUaeMobile(secondMobile);
  const overrideValid =
    !overrideEnabled ||
    (overrideFee !== "" && Number(overrideFee) >= 0 && overrideReason.trim() !== "");

  // One fee-entry path: an operator either overrides a configured price, or
  // enters a manual price when none is configured. Both send serviceFee + reason.
  const overriding = overrideEnabled && canOverrideFee;
  const feeInput = overriding ? overrideFee : manualFee;
  const reasonInput = overriding ? overrideReason : manualReason;
  const enteredFee = feeInput.trim() === "" ? undefined : Number(feeInput);
  const enteredReason = reasonInput.trim() === "" ? undefined : reasonInput.trim();
  // Only the fee is required for manual pricing; the reason is optional.
  const manualValid = !pricingMissing || (manualFee !== "" && Number(manualFee) >= 0);
  const moneyValid = Number(codAmount) >= 0;
  const identifiersValid = serialNumber.trim().length > 0 && identifierError === undefined;
  const valid =
    trader !== undefined &&
    (customer !== undefined || inlineCustomer !== undefined) &&
    area !== undefined &&
    customerName.trim() !== "" &&
    phoneValid &&
    secondPhoneValid &&
    address.trim() !== "" &&
    moneyValid &&
    Number(additionalFees) >= 0 &&
    identifiersValid &&
    Number(packageCount) >= 1 &&
    overrideValid &&
    manualValid &&
    quote !== undefined &&
    quoteError === undefined;
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

  const traderLabel = useCallback(
    (option: OperationsTraderOption) =>
      `${option.code} - ${locale === "ar" ? (option.nameAr ?? option.nameEn) : option.nameEn}`,
    [locale],
  );
  const traderSelectedLabel = useCallback(
    (option: OperationsTraderOption) =>
      locale === "ar" ? (option.nameAr ?? option.nameEn) : option.nameEn,
    [locale],
  );
  const customerLabel = useCallback(
    (option: CustomerOption) => `${option.code} - ${option.name} - ${option.mobileNumber}`,
    [],
  );
  const customerSelectedLabel = useCallback((option: CustomerOption) => option.name, []);
  const applyCustomer = useCallback((option: CustomerOption) => {
    setCustomer(option);
    setInlineCustomer(undefined);
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
    if (trader === undefined || area === undefined || !moneyValid || !overrideValid) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setQuoteLoading(true);
      void api
        .post<OperationsOrderQuote>("operations/orders/quote", {
          areaId: area.id,
          additionalFees: Number(additionalFees),
          codAmount: Number(codAmount),
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
    moneyValid,
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
    if (trader === undefined || area === undefined || pricingFee === "" || Number(pricingFee) < 0) {
      return;
    }
    setPricingSaving(true);
    setPricingError(undefined);
    try {
      const payload: Record<string, unknown> = {
        reason: pricingReason.trim() || undefined,
        serviceFee: Number(pricingFee),
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
    if (!valid) {
      event.currentTarget.querySelector<HTMLElement>(":invalid, [aria-invalid='true']")?.focus();
      setError(t("operations.correctOrderErrors"));
      return;
    }
    if (submittingRef.current || trader === undefined || area === undefined) return;
    submittingRef.current = true;
    setSaving(true);
    setError(undefined);
    try {
      const order = await api.post<OperationsOrder>(
        "operations/orders",
        {
          additionalFees: Number(additionalFees),
          areaId: area.id,
          codAmount: Number(codAmount),
          customerAddress: address.trim(),
          customerAddressId: customer?.addressId,
          customerDeliveryNotes: customerDeliveryNotes.trim() || undefined,
          customerId: customer?.id,
          customerLatitude: customer?.latitude == null ? undefined : Number(customer.latitude),
          customerLocationLink: customer?.locationLink ?? undefined,
          customerLongitude: customer?.longitude == null ? undefined : Number(customer.longitude),
          customerMobileNumber: normalizeUaeMobile(mobile) ?? mobile.trim(),
          customerName: customerName.trim(),
          customerSecondMobileNumber:
            secondMobile.trim() === ""
              ? undefined
              : (normalizeUaeMobile(secondMobile) ?? secondMobile.trim()),
          driverId: driverId || undefined,
          notes: notes.trim() || undefined,
          packageCount: Number(packageCount),
          referenceNumber: referenceNumber.trim() || undefined,
          serialNumber: serialNumber.trim(),
          serviceFee: enteredFee,
          serviceFeeOverrideReason: enteredReason,
          traderId: trader.id,
          ...(inlineCustomer === undefined
            ? {}
            : {
                inlineCustomer: {
                  address: inlineCustomer.address.trim(),
                  areaId: inlineCustomer.area.id,
                  mobileNumber:
                    normalizeUaeMobile(inlineCustomer.mobileNumber) ??
                    inlineCustomer.mobileNumber.trim(),
                  name: inlineCustomer.name.trim(),
                  secondMobileNumber:
                    inlineCustomer.secondMobileNumber === undefined
                      ? undefined
                      : (normalizeUaeMobile(inlineCustomer.secondMobileNumber) ??
                        inlineCustomer.secondMobileNumber.trim()),
                },
              }),
        },
        { "X-Idempotency-Key": idempotencyKeyRef.current },
      );
      setCreatedOrder(order);
      await onSaved();
    } catch (requestError) {
      setError(
        requestError instanceof ApiError && requestError.code === "pricing_not_configured"
          ? t("operations.pricingNotConfigured")
          : requestError instanceof Error
            ? requestError.message
            : t("operations.createOrderFailed"),
      );
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  };

  const money = (value: string | undefined) => formatCurrency(value ?? "0", "AED", locale);

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
          <form className="order-form" noValidate onSubmit={(event) => void submit(event)}>
            <div className="order-modal-scroll">
              {error === undefined ? null : (
                <div className="alert alert-error" role="alert">
                  {error}
                </div>
              )}
              <div className="order-form-columns">
                <section className="order-form-group" aria-labelledby="order-customer-heading">
                  <div className="form-section-heading">
                    <span aria-hidden="true">01</span>
                    <h3 id="order-customer-heading">{t("operations.orderCustomerInfo")}</h3>
                  </div>
                  <div className="form-grid">
                    <label className="field required-field">
                      <span>{t("operations.serialNumber")}</span>
                      <input
                        aria-invalid={identifierError !== undefined}
                        autoComplete="off"
                        maxLength={100}
                        onChange={(event) => setSerialNumber(event.target.value)}
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
                  {identifierError === undefined ? null : (
                    <small className="field-error" role="alert">
                      {identifierError}
                    </small>
                  )}
                  <label className="field required-field">
                    <span>{t("operations.trader")}</span>
                    <div className="input-with-action">
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
                        }}
                        path="operations/traders/search"
                        placeholder={t("operations.searchTrader")}
                        value={trader}
                      />
                      <button
                        aria-label={t("operations.addNewTrader")}
                        className="icon-button"
                        onClick={() => setCreateTraderOpen(true)}
                        title={t("operations.addNewTrader")}
                        type="button"
                      >
                        <UserPlus size={18} />
                      </button>
                    </div>
                  </label>
                  <label className="field required-field">
                    <span>{t("customerConfig.customer")}</span>
                    <div className="input-with-action">
                      <SearchCombobox
                        {...(searchDebounceMs === undefined
                          ? {}
                          : { debounceMs: searchDebounceMs })}
                        api={api}
                        emptyText={t("customerConfig.noCustomers")}
                        getLabel={customerLabel}
                        getSelectedLabel={customerSelectedLabel}
                        label={t("customerConfig.customer")}
                        onChange={(selected) => {
                          if (selected) {
                            applyCustomer(selected);
                            void api
                              .get<{ addresses: readonly Record<string, unknown>[] }>(
                                `configuration/customers/${encodeURIComponent(selected.code)}`,
                              )
                              .then((detail) => setCustomerAddresses(detail.addresses));
                          } else {
                            setCustomer(undefined);
                            setInlineCustomer(undefined);
                            setCustomerAddresses([]);
                          }
                        }}
                        path="configuration/customers/search"
                        placeholder={t("customerConfig.searchPlaceholder")}
                        value={customer}
                      />
                      <button
                        aria-label={t("customerConfig.addNewFromOrder")}
                        className="icon-button"
                        onClick={() => setCreateCustomerOpen(true)}
                        title={t("customerConfig.addNewFromOrder")}
                        type="button"
                      >
                        <UserPlus size={18} />
                      </button>
                    </div>
                  </label>
                  {customer !== undefined && customerAddresses.length > 1 ? (
                    <label className="field required-field">
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
                  {/* The selected Customer's name is authoritative and shown
                      read-only, not a second editable field. */}
                  {customer === undefined && inlineCustomer === undefined ? null : (
                    <label className="field">
                      <span>{t("operations.customerName")}</span>
                      <input data-testid="customer-name" readOnly value={customerName} />
                    </label>
                  )}
                  <div className="form-grid">
                    <label className="field required-field">
                      <span>{t("operations.mobile")}</span>
                      <input
                        aria-describedby={mobile !== "" && !phoneValid ? "mobile-error" : undefined}
                        aria-invalid={mobile !== "" && !phoneValid}
                        autoComplete="tel"
                        inputMode="tel"
                        maxLength={16}
                        onChange={(event) => setMobile(event.target.value)}
                        placeholder={t("common.mobilePlaceholder")}
                        required
                        value={mobile}
                      />
                      {mobile !== "" && !phoneValid ? (
                        <small className="field-error" id="mobile-error">
                          {t("operations.mobileFormatError")}
                        </small>
                      ) : null}
                    </label>
                    <label className="field">
                      <span>{t("operations.secondMobile")}</span>
                      <input
                        aria-invalid={!secondPhoneValid}
                        autoComplete="tel"
                        inputMode="tel"
                        maxLength={16}
                        onChange={(event) => setSecondMobile(event.target.value)}
                        placeholder={t("common.mobilePlaceholder")}
                        value={secondMobile}
                      />
                      {!secondPhoneValid ? (
                        <small className="field-error">{t("operations.mobileFormatError")}</small>
                      ) : null}
                    </label>
                  </div>
                  <AreaSelector
                    allowCreate={canCreateArea && customer === undefined}
                    api={api}
                    disabled={customer !== undefined}
                    onChange={(selected) => {
                      setArea(selected);
                      setOverrideEnabled(false);
                    }}
                    {...(searchDebounceMs === undefined ? {} : { searchDebounceMs })}
                    value={area}
                  />
                  <label className="field required-field field-grow">
                    <span>{t("operations.customerAddress")}</span>
                    <textarea
                      maxLength={500}
                      onChange={(event) => setAddress(event.target.value)}
                      required
                      rows={3}
                      value={address}
                    />
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
                    <div className="field">
                      <span>{t("operations.orderType")}</span>
                      <strong>{t("operations.internalDelivery")}</strong>
                    </div>
                    <div className="field">
                      <span>{t("operations.paymentCondition")}</span>
                      <strong>{t("operations.customerPaysCod")}</strong>
                    </div>
                  </div>
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
                  <div className="form-grid">
                    <label className="field required-field">
                      <span>{t("operations.codAmount")}</span>
                      <input
                        aria-invalid={Number(codAmount) < 0}
                        min="0"
                        onChange={(event) => setCodAmount(event.target.value)}
                        required
                        step="0.01"
                        type="number"
                        value={codAmount}
                      />
                    </label>
                    <label className="field">
                      <span>{t("operations.serviceFee")}</span>
                      <input readOnly value={quote?.configuredServiceFee ?? ""} />
                    </label>
                  </div>
                  <label className="field">
                    <span>{t("operations.additionalFees")}</span>
                    <input
                      aria-invalid={Number(additionalFees) < 0}
                      min="0"
                      onChange={(event) => setAdditionalFees(event.target.value)}
                      step="0.01"
                      type="number"
                      value={additionalFees}
                    />
                  </label>
                  {pricingMissing ? (
                    <div className="fee-override">
                      <p className="field-hint">{t("operations.manualPricingHint")}</p>
                      {canCreateArea && !addPricingOpen ? (
                        <button
                          className="button button-secondary"
                          onClick={() => {
                            setPricingScope(hasEmirate ? "area" : "global");
                            setAddPricingOpen(true);
                          }}
                          type="button"
                        >
                          {t("operations.addPricing")}
                        </button>
                      ) : null}
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
                              disabled={
                                pricingSaving || pricingFee === "" || Number(pricingFee) < 0
                              }
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
                              className="no-spinner"
                              inputMode="decimal"
                              min="0"
                              onChange={(event) => setManualFee(event.target.value)}
                              required
                              step="0.01"
                              type="number"
                              value={manualFee}
                            />
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
                    <div className="fee-override">
                      <label className="checkbox-field">
                        <input
                          checked={overrideEnabled}
                          onChange={(event) => setOverrideEnabled(event.target.checked)}
                          type="checkbox"
                        />
                        <span>{t("operations.overrideServiceFee")}</span>
                      </label>
                      {overrideEnabled ? (
                        <>
                          <label className="field required-field">
                            <span>{t("operations.overriddenFee")}</span>
                            <input
                              className="no-spinner"
                              inputMode="decimal"
                              min="0"
                              onChange={(event) => setOverrideFee(event.target.value)}
                              required
                              step="0.01"
                              type="number"
                              value={overrideFee}
                            />
                          </label>
                          <label className="field required-field">
                            <span>{t("operations.overrideReason")}</span>
                            <textarea
                              maxLength={500}
                              onChange={(event) => setOverrideReason(event.target.value)}
                              required
                              rows={2}
                              value={overrideReason}
                            />
                          </label>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="form-grid">
                    <label className="field required-field">
                      <span>{t("operations.packages")}</span>
                      <input
                        className="input-compact"
                        min="1"
                        onChange={(event) => setPackageCount(event.target.value)}
                        required
                        step="1"
                        type="number"
                        value={packageCount}
                      />
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
                  <div className="quote-panel" aria-live="polite">
                    {quoteLoading ? (
                      <strong>{t("common.loading")}</strong>
                    ) : quoteError === undefined ? (
                      <>
                        <div>
                          <span>{t("operations.totalAmountToCollect")}</span>
                          <strong>{money(quote?.customerAmountDue)}</strong>
                        </div>
                        <div>
                          <span>{t("operations.amountDueToTrader")}</span>
                          <strong>{money(quote?.traderNetPayable)}</strong>
                        </div>
                        <div>
                          <span>{t("operations.totalDeductions")}</span>
                          <strong>{money(quote?.totalDeductions)}</strong>
                        </div>
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
                </section>
              </div>
            </div>
            <footer className="order-action-bar">
              <div className="order-totals" aria-label={t("operations.orderSummary")}>
                <span>
                  <small>{t("operations.codAmount")}</small>
                  <strong>{money(quote?.codAmount ?? codAmount)}</strong>
                </span>
                <span>
                  <small>{t("operations.serviceFee")}</small>
                  <strong>{money(quote?.serviceFee)}</strong>
                </span>
                <span>
                  <small>{t("operations.additionalFees")}</small>
                  <strong>{money(quote?.additionalFees)}</strong>
                </span>
                {quote?.vatEnabled ? (
                  <span>
                    <small>{t("operations.vatAmount")}</small>
                    <strong>{money(quote.vatAmount)}</strong>
                  </span>
                ) : null}
                <span className="total-due">
                  <small>{t("operations.totalAmountToCollect")}</small>
                  <strong>{money(quote?.customerAmountDue)}</strong>
                </span>
              </div>
              <div className="modal-actions order-actions">
                <button className="button button-secondary" onClick={requestClose} type="button">
                  {t("common.cancel")}
                </button>
                <button
                  className="button button-primary"
                  disabled={!valid || saving || quoteLoading}
                  type="submit"
                >
                  {saving ? t("common.working") : t("operations.createOrder")}
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
      {createCustomerOpen ? (
        <InlineCustomerDialog
          api={api}
          canCreateArea={canCreateArea}
          initial={{
            address,
            area,
            mobileNumber: mobile,
            name: customerName,
            secondMobileNumber: secondMobile,
          }}
          onClose={() => setCreateCustomerOpen(false)}
          onSaved={(created) => {
            setCustomer(undefined);
            setCustomerAddresses([]);
            setInlineCustomer(created);
            setCustomerName(created.name);
            setMobile(created.mobileNumber);
            setSecondMobile(created.secondMobileNumber ?? "");
            setAddress(created.address);
            setArea(created.area);
            setCreateCustomerOpen(false);
          }}
        />
      ) : null}
      {createTraderOpen ? (
        <TraderForm
          api={api}
          onClose={() => setCreateTraderOpen(false)}
          onSaved={(created) => {
            setCreateTraderOpen(false);
            if (created === undefined) return;
            // Return with the new Trader selected, like the Customer flow.
            const code = String(created.code ?? "");
            void api
              .get<SearchPage<OperationsTraderOption>>(
                `operations/traders/search?search=${encodeURIComponent(code)}&limit=1&offset=0`,
              )
              .then((page) => {
                const option = page.items[0];
                if (option) setTrader(option);
              });
          }}
        />
      ) : null}
    </>
  );
}

function InlineCustomerDialog({
  api,
  canCreateArea,
  initial,
  onClose,
  onSaved,
}: {
  api: ApiClient;
  canCreateArea: boolean;
  initial: {
    readonly address: string;
    readonly area: CompanyArea | undefined;
    readonly mobileNumber: string;
    readonly name: string;
    readonly secondMobileNumber: string;
  };
  onClose: () => void;
  onSaved: (draft: InlineCustomerDraft) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial.name);
  const [mobileNumber, setMobileNumber] = useState(initial.mobileNumber);
  const [secondMobileNumber, setSecondMobileNumber] = useState(initial.secondMobileNumber);
  const [area, setArea] = useState(initial.area);
  const [address, setAddress] = useState(initial.address);
  const mobileValid = isUaeMobile(mobileNumber);
  const secondValid = secondMobileNumber.trim() === "" || isUaeMobile(secondMobileNumber);
  const valid =
    name.trim() !== "" && mobileValid && secondValid && area !== undefined && address.trim() !== "";

  return (
    <Modal
      closeLabel={t("common.close")}
      onRequestClose={onClose}
      title={t("customerConfig.addCustomer")}
      titleId="inline-order-customer-title"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || area === undefined) return;
          onSaved({
            address: address.trim(),
            area,
            mobileNumber: normalizeUaeMobile(mobileNumber) ?? mobileNumber.trim(),
            name: name.trim(),
            ...(secondMobileNumber.trim() === ""
              ? {}
              : {
                  secondMobileNumber:
                    normalizeUaeMobile(secondMobileNumber) ?? secondMobileNumber.trim(),
                }),
          });
        }}
      >
        <div className="modal-form-grid">
          <label className="field required-field">
            <span>{t("operations.customerName")}</span>
            <input
              autoFocus
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </label>
          <label className="field required-field">
            <span>{t("operations.mobile")}</span>
            <input
              aria-invalid={mobileNumber !== "" && !mobileValid}
              inputMode="tel"
              onChange={(event) => setMobileNumber(event.target.value)}
              placeholder={t("common.mobilePlaceholder")}
              required
              value={mobileNumber}
            />
            {mobileNumber !== "" && !mobileValid ? (
              <small className="field-error">{t("operations.mobileFormatError")}</small>
            ) : null}
          </label>
          <label className="field">
            <span>{t("operations.secondMobile")}</span>
            <input
              aria-invalid={!secondValid}
              inputMode="tel"
              onChange={(event) => setSecondMobileNumber(event.target.value)}
              placeholder={t("common.mobilePlaceholder")}
              value={secondMobileNumber}
            />
          </label>
          <AreaSelector
            allowCreate={canCreateArea}
            api={api}
            onChange={setArea}
            value={area}
          />
          <label className="field required-field">
            <span>{t("operations.customerAddress")}</span>
            <textarea
              maxLength={500}
              onChange={(event) => setAddress(event.target.value)}
              required
              rows={3}
              value={address}
            />
          </label>
        </div>
        <div className="modal-actions">
          <button className="button button-secondary" onClick={onClose} type="button">
            {t("common.cancel")}
          </button>
          <button className="button button-primary" disabled={!valid} type="submit">
            {t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
