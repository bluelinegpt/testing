import { useEffect, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  PlatformApiError,
  platformApi,
  type ApprovedTemplateOption,
} from "../api/platform-client.js";

/**
 * Create Company: a form, then a review, then one action.
 *
 * Creation is important but not destructive, so a review step is the right
 * weight — enough to catch a mistyped subdomain, not the double confirmation a
 * data-destroying action would deserve.
 *
 * Everything the form offers is a business field. There is no place to enter an
 * identifier, a status, a template file or an opening balance: the server
 * generates the first two, chooses the template from its own registry, and a
 * new Company begins with no balances at all.
 */
const environments = ["sandbox", "development", "demo", "trial", "production"] as const;

interface FormState {
  name: string;
  subdomain: string;
  shipmentPrefix: string;
  environment: string;
  defaultLanguage: string;
  contactName: string;
  telephone: string;
  email: string;
  businessDayStart: string;
  template: string;
}

const initialState: FormState = {
  name: "",
  subdomain: "",
  shipmentPrefix: "",
  // Not production. The safest default for a Company someone is creating by
  // hand is the one that is easiest to recover from; production is an explicit
  // choice.
  environment: "sandbox",
  defaultLanguage: "en",
  contactName: "",
  telephone: "",
  email: "",
  // Blank means "use the approved template's default", which is the whole
  // point of a template default. It is not silently substituted here.
  businessDayStart: "",
  // The latest approved version, not hardcoded to "always @1": v2 is the same
  // Chart of Accounts, mappings and policy as v1 plus the one thing v1 left
  // every new Company without -- a working set of delivery Areas. v1 stays
  // selectable below for a Company that genuinely needs it, and stays valid
  // forever for Companies already initialised from it.
  template: "UAE_DELIVERY_STANDARD@2",
};

export function CreateCompanyPage(): ReactElement {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(initialState);
  const [templates, setTemplates] = useState<readonly ApprovedTemplateOption[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [subdomainEdited, setSubdomainEdited] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void platformApi
      .approvedTemplates()
      .then((options) => {
        if (!cancelled) setTemplates(options);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const set = (field: keyof FormState) => (value: string) =>
    setForm((current) => ({ ...current, [field]: value }));

  function review(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(undefined);
    setReviewing(true);
  }

  async function submit(): Promise<void> {
    setSubmitting(true);
    setError(undefined);
    const [templateCode, templateVersion] = form.template.split("@");
    try {
      const created = await platformApi.createCompany({
        name: form.name,
        shipmentPrefix: form.shipmentPrefix,
        ...(form.subdomain === "" ? {} : { subdomain: form.subdomain }),
        environment: form.environment,
        defaultLanguage: form.defaultLanguage,
        ...(form.contactName === "" ? {} : { contactName: form.contactName }),
        ...(form.telephone === "" ? {} : { telephone: form.telephone }),
        ...(form.businessDayStart === "" ? {} : { businessDayStart: form.businessDayStart }),
        ...(form.email === "" ? {} : { email: form.email }),
        ...(form.template === ""
          ? {}
          : {
              accountingTemplateCode: templateCode,
              accountingTemplateVersion: Number(templateVersion ?? 1),
            }),
      });
      navigate(`/companies/${created.companyId}`);
    } catch (failure) {
      // The API's message is shown verbatim for the cases a person can act on —
      // a taken code, a reserved subdomain — because "something went wrong"
      // would leave them guessing which field to change.
      setError(
        failure instanceof PlatformApiError ? failure.message : "The Company could not be created.",
      );
      setSubmitting(false);
      setReviewing(false);
    }
  }

  if (reviewing) {
    return (
      <section className="platform-panel">
        <h2>Review</h2>
        <p className="platform-muted">
          The Company is created in <strong>Draft</strong>. Its Accounting setup is applied in the
          same step, and nothing is activated yet.
        </p>
        <dl className="platform-review">
          {[
            ["Name", form.name],
            ["Company Code", "Generated automatically"],
            ["Subdomain", form.subdomain],
            ["Shipment prefix", form.shipmentPrefix],
            ["Environment", form.environment],
            ["Country", "United Arab Emirates"],
            ["Timezone", "Asia/Dubai"],
            ["Currency", "AED"],
            ["Default language", form.defaultLanguage],
            ["Business day", form.businessDayStart === "" ? "08:00" : form.businessDayStart],
            ["Accounting template", form.template === "" ? "None" : form.template],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {error === undefined ? null : (
          <p className="platform-login__error" role="alert">
            {error}
          </p>
        )}
        <div className="platform-actions">
          <button
            className="platform-button platform-button--quiet"
            disabled={submitting}
            onClick={() => setReviewing(false)}
            type="button"
          >
            Back
          </button>
          <button
            className="platform-button"
            disabled={submitting}
            onClick={() => void submit()}
            type="button"
          >
            {submitting ? "Creating…" : "Create Company"}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="platform-panel">
      <div className="platform-panel__header">
        <h2>Create Company</h2>
        <Link className="platform-button platform-button--quiet" to="/companies">
          Cancel
        </Link>
      </div>

      <form className="platform-form" onSubmit={review}>
        <h3>Company</h3>
        <Field
          id="name"
          label="Company Name"
          onChange={(value) => {
            set("name")(value);
            if (!subdomainEdited) set("subdomain")(suggestSubdomain(value));
          }}
          required
          value={form.name}
        />
        <Field
          hint="Suggested from the Company name. Edit only when a different portal address is needed."
          id="subdomain"
          label="Subdomain"
          onChange={(value) => {
            setSubdomainEdited(true);
            set("subdomain")(value.toLowerCase());
          }}
          required
          value={form.subdomain}
        />
        <Field
          hint="Exactly three letters. It may be corrected before shipment numbering is activated."
          id="shipment-prefix"
          label="Shipment Prefix"
          onChange={(value) =>
            set("shipmentPrefix")(
              value
                .replace(/[^A-Za-z]/g, "")
                .toUpperCase()
                .slice(0, 3),
            )
          }
          required
          value={form.shipmentPrefix}
        />
        <div className="platform-field-group">
          <label className="platform-field" htmlFor="environment">
            <span>Environment</span>
            <select
              aria-describedby="environment-hint"
              id="environment"
              onChange={(event) => set("environment")(event.target.value)}
              value={form.environment}
            >
              {environments.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <small className="platform-muted" id="environment-hint">
            Fixed once the Company is created. Production is protected from destructive maintenance.
          </small>
        </div>

        <h3>Settings</h3>
        <dl className="platform-review">
          <div>
            <dt>Country</dt>
            <dd>United Arab Emirates</dd>
          </div>
          <div>
            <dt>Currency</dt>
            <dd>AED</dd>
          </div>
          <div>
            <dt>Timezone</dt>
            <dd>Dubai (Asia/Dubai)</dd>
          </div>
        </dl>
        <label className="platform-field" htmlFor="defaultLanguage">
          <span>Default language</span>
          <select
            id="defaultLanguage"
            onChange={(event) => set("defaultLanguage")(event.target.value)}
            value={form.defaultLanguage}
          >
            <option value="en">en</option>
            <option value="ar">ar</option>
          </select>
        </label>
        <Field
          id="businessDayStart"
          label="Business Day Start"
          onChange={set("businessDayStart")}
          type="time"
          value={form.businessDayStart}
        />

        <h3>Accounting</h3>
        <div className="platform-field-group">
          <label className="platform-field" htmlFor="template">
            <span>Setup template</span>
            <select
              aria-describedby="template-hint"
              id="template"
              onChange={(event) => set("template")(event.target.value)}
              value={form.template}
            >
              {templates.map((option) => (
                <option
                  key={`${option.templateCode}@${option.templateVersion}`}
                  value={`${option.templateCode}@${option.templateVersion}`}
                >
                  {option.displayName} (v{option.templateVersion})
                </option>
              ))}
              <option value="">No accounting setup</option>
            </select>
          </label>
          <small className="platform-muted" id="template-hint">
            Applies the Chart of Accounts, mappings and configuration. No balances or transactions
            are created.
          </small>
        </div>

        <h3>Contact</h3>
        <Field
          id="contactName"
          label="Contact name"
          onChange={set("contactName")}
          value={form.contactName}
        />
        <Field
          id="telephone"
          label="Telephone"
          onChange={set("telephone")}
          value={form.telephone}
        />
        <Field id="email" label="Email" onChange={set("email")} type="email" value={form.email} />

        {error === undefined ? null : (
          <p className="platform-login__error" role="alert">
            {error}
          </p>
        )}
        <div className="platform-actions">
          <button className="platform-button" type="submit">
            Review
          </button>
        </div>
      </form>
    </section>
  );
}

function suggestSubdomain(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63)
    .replace(/-$/g, "");
}

/**
 * A labelled input, with its hint OUTSIDE the label.
 *
 * Hint text nested inside a `<label>` becomes part of the field's accessible
 * name, so a screen reader announces "Code Uppercase letters, digits and
 * hyphens…" instead of "Code". `aria-describedby` is the right relationship:
 * the hint is a description, not part of the name.
 */
function Field(input: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  hint?: string;
  type?: string;
}): ReactElement {
  const hintId = `${input.id}-hint`;
  return (
    <div className="platform-field-group">
      <label className="platform-field" htmlFor={input.id}>
        <span>{input.label}</span>
        <input
          {...(input.hint === undefined ? {} : { "aria-describedby": hintId })}
          id={input.id}
          onChange={(event) => input.onChange(event.target.value)}
          required={input.required === true}
          type={input.type ?? "text"}
          value={input.value}
        />
      </label>
      {input.hint === undefined ? null : (
        <small className="platform-muted" id={hintId}>
          {input.hint}
        </small>
      )}
    </div>
  );
}
