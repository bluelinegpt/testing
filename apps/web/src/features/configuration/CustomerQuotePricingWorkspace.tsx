import { useEffect, useState } from "react";
const json = { "Content-Type": "application/json" };
type Data = {
  participation: {
    participates: boolean;
    acceptsInstant: boolean;
    acceptsCustom: boolean;
    activeFrom: string;
  };
  profiles: Array<{
    id: string;
    name: string;
    status: string;
    service_type: string;
    rules: unknown[];
  }>;
};
async function request(path: string, options?: RequestInit) {
  const response = await fetch(`/api/v1/customer-quote-marketplace${path}`, {
    credentials: "include",
    ...options,
    headers: { ...json, ...options?.headers },
  });
  if (!response.ok)
    throw new Error(
      (await response.json().catch(() => ({ message: "Request failed" }))).message ??
        "Request failed",
    );
  return response.json();
}
export function CustomerQuotePricingWorkspace() {
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [profileName, setProfileName] = useState("Ajman to Dubai Standard"),
    [profileId, setProfileId] = useState(""),
    [base, setBase] = useState("40");
  const load = () =>
    request("/configuration")
      .then(setData)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  if (!data)
    return (
      <section className="workspace-panel">
        <h1>Customer Quote Pricing</h1>
        <p>{error || "Loading…"}</p>
      </section>
    );
  const participation = data.participation;
  return (
    <section className="workspace-panel customer-pricing">
      <header>
        <p className="eyebrow">Tawseelhub Customer Requests</p>
        <h1>Customer Quote Pricing</h1>
        <p>
          This pricing is used only for public Tawseelhub package requests. Trader contract pricing
          is unchanged.
        </p>
      </header>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <article className="configuration-card">
        <h2>Participation</h2>
        <label>
          <input
            type="checkbox"
            checked={participation.participates}
            onChange={async (e) => {
              try {
                setData(
                  await request("/participation", {
                    method: "PATCH",
                    body: JSON.stringify({
                      ...participation,
                      participates: e.target.checked,
                      acceptsInstant: e.target.checked && participation.acceptsInstant,
                      acceptsCustom: e.target.checked && participation.acceptsCustom,
                    }),
                  }),
                );
              } catch (x) {
                setError((x as Error).message);
              }
            }}
          />{" "}
          Participate in Customer Delivery Requests
        </label>
        <label>
          <input
            type="checkbox"
            checked={participation.acceptsInstant}
            disabled={!participation.participates}
            onChange={async (e) =>
              setData(
                await request("/participation", {
                  method: "PATCH",
                  body: JSON.stringify({ ...participation, acceptsInstant: e.target.checked }),
                }),
              )
            }
          />{" "}
          Accept Instant Quote Requests
        </label>
        <label>
          <input
            type="checkbox"
            checked={participation.acceptsCustom}
            disabled={!participation.participates}
            onChange={async (e) =>
              setData(
                await request("/participation", {
                  method: "PATCH",
                  body: JSON.stringify({ ...participation, acceptsCustom: e.target.checked }),
                }),
              )
            }
          />{" "}
          Accept Custom Quote Requests
        </label>
      </article>
      <article className="configuration-card">
        <h2>Create pricing profile</h2>
        <div className="form-grid">
          <label>
            Name
            <input value={profileName} onChange={(e) => setProfileName(e.target.value)} />
          </label>
          <label>
            Service
            <select id="service">
              <option value="standard">Standard</option>
              <option value="same_day">Same Day</option>
              <option value="express">Express</option>
            </select>
          </label>
          <button
            onClick={async () => {
              const created = await request("/profiles", {
                method: "POST",
                body: JSON.stringify({
                  name: profileName,
                  serviceType: (document.getElementById("service") as HTMLSelectElement).value,
                  effectiveFrom: new Date().toISOString().slice(0, 10),
                  maxCodAmount: 5000,
                  maxWeightKg: 25,
                  supportedPackageTypes: [
                    "document",
                    "small_parcel",
                    "medium_parcel",
                    "large_parcel",
                    "box",
                    "fragile_item",
                    "food",
                    "electronics",
                    "clothing",
                    "other",
                  ],
                }),
              });
              setProfileId(created.id);
              load();
            }}
          >
            Create Draft
          </button>
        </div>
      </article>
      <article className="configuration-card">
        <h2>Add route rule</h2>
        <div className="form-grid">
          <label>
            Profile
            <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              <option value="">Select</option>
              {data.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Pickup Emirate
            <select id="pickup">
              <option value="ajman">Ajman</option>
              <option value="dubai">Dubai</option>
            </select>
          </label>
          <label>
            Delivery Emirate
            <select id="delivery">
              <option value="dubai">Dubai</option>
              <option value="ajman">Ajman</option>
            </select>
          </label>
          <label>
            Base price (AED)
            <input type="number" value={base} onChange={(e) => setBase(e.target.value)} />
          </label>
          <button
            disabled={!profileId}
            onClick={async () => {
              await request(`/profiles/${profileId}/rules`, {
                method: "POST",
                body: JSON.stringify({
                  pickupEmirate: (document.getElementById("pickup") as HTMLSelectElement).value,
                  deliveryEmirate: (document.getElementById("delivery") as HTMLSelectElement).value,
                  basePrice: Number(base),
                  includedWeightKg: 5,
                  extraWeightPrice: 3,
                  codSurcharge: 0,
                  maximumStandardWeight: 25,
                }),
              });
              await request(`/profiles/${profileId}/activate`, { method: "PATCH" });
              load();
            }}
          >
            Save & Activate
          </button>
        </div>
      </article>
      <article className="configuration-card">
        <h2>Profiles</h2>
        {data.profiles.map((p) => (
          <div className="pricing-row" key={p.id}>
            <strong>{p.name}</strong>
            <span>
              {p.service_type} · {p.status} · {p.rules.length} rule(s)
            </span>
          </div>
        ))}
      </article>
    </section>
  );
}
