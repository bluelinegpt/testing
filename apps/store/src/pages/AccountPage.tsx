import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useLocation } from "react-router-dom";

import {
  type CustomerAddress,
  type CustomerProfile,
  fetchCustomerAddresses,
  fetchCustomerProfile,
  logoutCustomer,
  updateCustomerProfile,
} from "../api/customer-auth-client.js";
import { useCustomerSession } from "../auth/customer-session-context.js";
import { MessageState } from "../components/States.js";
import { useLocalePath } from "../routing/locale-routing.js";

/**
 * §50/§51: the authenticated Customer's account screen.
 *
 * The route guard lives here rather than in a wrapper route element so the
 * "loading" session state can show nothing (avoiding a flash of the login
 * redirect) while `anonymous` redirects immediately with `returnTo` set to
 * this exact page -- the localized, relative path only (§36/§51).
 */
export function AccountPage() {
  const localePath = useLocalePath();
  const location = useLocation();
  const { session } = useCustomerSession();

  if (session.status === "loading") return null;
  if (session.status === "anonymous") {
    const returnTo = encodeURIComponent(location.pathname);
    return <Navigate replace to={`${localePath("/login")}?returnTo=${returnTo}`} />;
  }
  return <AccountContent />;
}

function AccountContent() {
  const { t } = useTranslation();
  const localePath = useLocalePath();
  const { setSession } = useCustomerSession();

  const [profile, setProfile] = useState<CustomerProfile>();
  const [addresses, setAddresses] = useState<readonly CustomerAddress[]>();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [preferredLanguage, setPreferredLanguage] = useState<"ar" | "en">("en");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  // §26: Customer Account is one of the pages that must offer reusable
  // retry on a genuine network failure (never on an ordinary "not signed
  // in" response, which the outer guard already handles).
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    const [profileResult, addressResult] = await Promise.all([
      fetchCustomerProfile(),
      fetchCustomerAddresses(),
    ]);
    if (profileResult.kind === "ok") {
      setProfile(profileResult.value);
      setName(profileResult.value.name);
      setEmail(profileResult.value.email ?? "");
      setPreferredLanguage(profileResult.value.preferredLanguage === "ar" ? "ar" : "en");
    } else if (profileResult.error.errorCode === "network_error") {
      setLoadFailed(true);
    }
    if (addressResult.kind === "ok") setAddresses(addressResult.value);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadFailed) {
    return (
      <div className="store-container">
        <MessageState
          bodyKey="errors.network.body"
          onRetry={() => void load()}
          titleKey="errors.network.title"
          tone="error"
        />
      </div>
    );
  }

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    setSaved(false);
    setSaving(true);
    try {
      const result = await updateCustomerProfile({
        name,
        preferredLanguage,
        ...(email.trim() === "" ? {} : { email: email.trim() }),
      });
      if (result.kind === "error") {
        setError(t(`auth.errors.${result.error.errorCode}`, result.error.message));
        return;
      }
      setProfile(result.value);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  const logout = async () => {
    await logoutCustomer();
    setSession(null);
  };

  return (
    <div className="store-container">
      <h1>{t("auth.account.title")}</h1>
      <div className="store-account-grid">
        <section className="store-account-section">
          <h2>{t("auth.account.businessInfo")}</h2>
          {error === undefined ? null : (
            <p className="store-form-error" role="alert">
              {error}
            </p>
          )}
          {saved ? (
            <p className="store-form-success" role="status">
              {t("auth.account.saved")}
            </p>
          ) : null}
          <form className="store-form" onSubmit={(event) => void saveProfile(event)}>
            <div className="store-field">
              <label htmlFor="account-name">{t("auth.account.name")}</label>
              <input
                id="account-name"
                onChange={(event) => setName(event.target.value)}
                required
                value={name}
              />
            </div>
            <div className="store-field">
              <label htmlFor="account-mobile">{t("auth.account.mobile")}</label>
              <input dir="ltr" disabled id="account-mobile" value={profile?.mobile ?? ""} />
            </div>
            <div className="store-field">
              <label htmlFor="account-email">{t("auth.account.email")}</label>
              <input
                dir="ltr"
                id="account-email"
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                value={email}
              />
            </div>
            <div className="store-field">
              <label htmlFor="account-language">{t("auth.account.preferredLanguage")}</label>
              <select
                id="account-language"
                onChange={(event) => setPreferredLanguage(event.target.value === "ar" ? "ar" : "en")}
                value={preferredLanguage}
              >
                <option value="en">{t("common.english")}</option>
                <option value="ar">{t("common.arabic")}</option>
              </select>
            </div>
            <button className="store-button store-button--onnavy" disabled={saving} type="submit">
              {saving ? t("common.loading") : t("auth.account.save")}
            </button>
          </form>
          <button className="store-button store-button--quiet" onClick={() => void logout()} type="button">
            {t("auth.account.logout")}
          </button>
        </section>

        <section className="store-account-section">
          <h2>{t("auth.account.addresses")}</h2>
          {addresses !== undefined && addresses.length === 0 ? (
            <p>{t("auth.account.addressesEmpty")}</p>
          ) : null}
          {(addresses ?? []).map((address) => (
            <div className="store-address-card" key={address.id}>
              <strong>{address.recipientName}</strong>
              {address.isDefault ? (
                <span className="store-note store-note--action"> {t("auth.account.addressDefault")}</span>
              ) : null}
              <p dir="auto">
                {address.address}, {address.area ?? ""} {address.emirate}
              </p>
              <p dir="ltr">{address.mobile}</p>
            </div>
          ))}
        </section>

        <section className="store-account-section">
          <h2>{t("auth.account.myOrders")}</h2>
          <Link className="store-button store-button--onnavy" to={localePath("/account/orders")}>
            {t("orders.title")}
          </Link>
        </section>
      </div>
    </div>
  );
}
