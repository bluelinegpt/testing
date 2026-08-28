import { useEffect, useState, type ReactElement } from "react";
import {
  platformApi,
  type CompanyWebsite,
  type CompanyWebsiteSettings,
} from "../api/platform-client.js";

const empty: CompanyWebsiteSettings = {
  branding: {},
  languages: { en: true, ar: false, defaultLocale: "en" },
  presentation: {},
  contact: {
    whatsappEnabled: false,
    showPhone: false,
    showEmail: false,
    showWhatsapp: false,
    showAddress: false,
    showWorkingHours: false,
    workingHours: [],
  },
  services: [],
  coverage: [],
  benefits: [],
  socialLinks: {},
  functions: { trackingEnabled: true, requestDeliveryEnabled: true },
  seo: { indexable: true },
  knowledge: {
    audiences: [],
    packageTypes: [],
    cod: { supported: false },
    pricing: { mode: "request_confirmation" },
    faqs: [],
    instructions: {},
    tawseelhubAttribution: true,
  },
  agent: {
    enabled: false,
    suggestedActions: ["services", "coverage", "contact"],
    tone: "friendly_professional",
    unknownBehavior: "safe_response",
    capabilities: {
      companyInformation: true,
      tracking: true,
      deliveryRequest: true,
      quoteGuidance: true,
      whatsappHandoff: true,
      contactHandoff: true,
      faqAnswers: true,
      socialLinks: true,
    },
  },
  sections: [
    "hero",
    "about",
    "services",
    "coverage",
    "benefits",
    "tracking",
    "request_delivery",
    "working_hours",
    "location",
    "contact",
    "social",
    "footer",
  ].map((key, order) => ({ key, enabled: true, order })),
};
const localizedFields = [
  "displayName",
  "tagline",
  "about",
  "heroHeadline",
  "heroSubheadline",
  "primaryCtaLabel",
  "secondaryCtaLabel",
] as const;

export function CompanyWebsiteEditor({
  companyId,
  website,
  onSaved,
  onFailure,
}: {
  companyId: string;
  website: CompanyWebsite;
  onSaved: (website: CompanyWebsite) => void;
  onFailure: (error: unknown) => void;
}): ReactElement {
  const [settings, setSettings] = useState<CompanyWebsiteSettings>(() =>
    structuredClone(website.settings ?? empty),
  );
  const [busy, setBusy] = useState(false);
  const completeness = Math.round(
    ([
      settings.knowledge.description?.en,
      settings.services.length,
      settings.coverage.length,
      settings.contact.workingHours.length,
      Object.keys(settings.socialLinks).length,
      settings.knowledge.faqs.length,
    ].filter((value) => (Array.isArray(value) ? value.length > 0 : Boolean(value))).length /
      6) *
      100,
  );
  useEffect(() => setSettings(structuredClone(website.settings ?? empty)), [website.version]);
  const update = (recipe: (next: CompanyWebsiteSettings) => void) =>
    setSettings((current) => {
      const next = structuredClone(current);
      recipe(next);
      return next;
    });
  async function save(): Promise<void> {
    if (!website.slug || !website.templateKey) return;
    setBusy(true);
    try {
      onSaved(
        await platformApi.configureCompanyWebsite(companyId, {
          slug: website.slug,
          primaryLanguage: settings.languages.defaultLocale,
          defaultLocale: settings.languages.defaultLocale,
          templateKey: website.templateKey,
          expectedVersion: website.version ?? 0,
          settings,
        }),
      );
    } catch (error) {
      onFailure(error);
    } finally {
      setBusy(false);
    }
  }
  function addList(kind: "services" | "benefits"): void {
    const title = globalThis
      .prompt(`Enter ${kind === "services" ? "service" : "benefit"} title`)
      ?.trim();
    if (!title) return;
    update((next) =>
      next[kind].push({
        id: `${kind.slice(0, -1)}-${crypto.randomUUID().slice(0, 8)}`,
        title: { en: title },
        enabled: true,
        order: next[kind].length,
      }),
    );
  }
  function moveSection(index: number, direction: -1 | 1): void {
    update((next) => {
      const ordered = [...next.sections].sort((a, b) => a.order - b.order);
      const target = index + direction;
      if (target < 0 || target >= ordered.length) return;
      [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
      ordered.forEach((item, order) => (item.order = order));
      next.sections = ordered;
    });
  }
  return (
    <div className="website-editor">
      <div className="platform-panel__header">
        <div>
          <h4>Edit Website</h4>
          <p className="platform-muted">Saved changes remain draft until Publish.</p>
          <p>
            <strong>Website Information: {completeness}% complete</strong>
          </p>
        </div>
        <button
          className="platform-button"
          disabled={busy}
          onClick={() => void save()}
          type="button"
        >
          Save Draft
        </button>
      </div>
      <details open>
        <summary>Branding</summary>
        <div className="website-editor__grid">
          {(["primaryColor", "secondaryColor", "accentColor"] as const).map((key) => (
            <label className="platform-field" key={key}>
              <span>{key.replace("Color", " color")}</span>
              <input
                type="color"
                value={
                  settings.branding[key] ??
                  { primaryColor: "#123b5d", secondaryColor: "#dcecf4", accentColor: "#e2a93b" }[
                    key
                  ]
                }
                onChange={(event) =>
                  update((next) => {
                    next.branding[key] = event.target.value;
                  })
                }
              />
            </label>
          ))}
        </div>
        <button
          className="platform-button platform-button--quiet"
          onClick={() =>
            update((next) => {
              next.branding = {};
            })
          }
          type="button"
        >
          Reset theme defaults
        </button>
        <p className="platform-muted">
          The existing Company logo is used. No duplicate logo is stored.
        </p>
      </details>
      <details>
        <summary>Languages & content</summary>
        <div className="website-editor__grid">
          <label>
            <input
              checked={settings.languages.en}
              onChange={(e) =>
                update((n) => {
                  n.languages.en = e.target.checked;
                  if (!n.languages.en) n.languages.defaultLocale = "ar";
                })
              }
              type="checkbox"
            />{" "}
            English
          </label>
          <label>
            <input
              checked={settings.languages.ar}
              onChange={(e) =>
                update((n) => {
                  n.languages.ar = e.target.checked;
                  if (!n.languages.ar) n.languages.defaultLocale = "en";
                })
              }
              type="checkbox"
            />{" "}
            Arabic
          </label>
          <label className="platform-field">
            <span>Default language</span>
            <select
              value={settings.languages.defaultLocale}
              onChange={(e) =>
                update((n) => {
                  n.languages.defaultLocale = e.target.value as "en" | "ar";
                })
              }
            >
              {settings.languages.en ? <option value="en">English</option> : null}
              {settings.languages.ar ? <option value="ar">Arabic</option> : null}
            </select>
          </label>
        </div>
        {localizedFields.map((field) => (
          <div className="website-editor__localized" key={field}>
            <label className="platform-field">
              <span>{field} (EN)</span>
              <textarea
                value={(settings.presentation[field] as { en?: string } | undefined)?.en ?? ""}
                onChange={(e) =>
                  update((n) => {
                    n.presentation[field] = {
                      ...(n.presentation[field] as object),
                      en: e.target.value,
                    };
                  })
                }
              />
            </label>
            {settings.languages.ar ? (
              <label className="platform-field" dir="rtl">
                <span>{field} (AR)</span>
                <textarea
                  value={(settings.presentation[field] as { ar?: string } | undefined)?.ar ?? ""}
                  onChange={(e) =>
                    update((n) => {
                      n.presentation[field] = {
                        ...(n.presentation[field] as object),
                        ar: e.target.value,
                      };
                    })
                  }
                />
              </label>
            ) : null}
          </div>
        ))}
        <div className="website-editor__grid">
          {(["primaryCtaType", "secondaryCtaType"] as const).map((key) => (
            <label className="platform-field" key={key}>
              <span>{key}</span>
              <select
                value={(settings.presentation[key] as string | undefined) ?? "contact"}
                onChange={(event) =>
                  update((next) => {
                    next.presentation[key] = event.target.value;
                  })
                }
              >
                {["contact", "track", "request_delivery", "whatsapp", "call", "section"].map(
                  (value) => (
                    <option key={value} value={value}>
                      {value.replaceAll("_", " ")}
                    </option>
                  ),
                )}
              </select>
            </label>
          ))}
        </div>
      </details>
      <details>
        <summary>Services & Why Choose Us</summary>
        {(["services", "benefits"] as const).map((kind) => (
          <section key={kind}>
            <div className="platform-panel__header">
              <h5>{kind === "services" ? "Services" : "Benefits"}</h5>
              <button
                className="platform-button platform-button--quiet"
                onClick={() => addList(kind)}
                type="button"
              >
                Add
              </button>
            </div>
            {settings[kind].map((item, index) => (
              <div className="website-editor__row" key={item.id}>
                <input
                  aria-label={`${kind} title`}
                  value={item.title.en ?? ""}
                  onChange={(e) =>
                    update((n) => {
                      n[kind][index]!.title.en = e.target.value;
                    })
                  }
                />
                <input
                  aria-label={`${kind} description`}
                  value={item.description?.en ?? ""}
                  onChange={(e) =>
                    update((n) => {
                      n[kind][index]!.description = { en: e.target.value };
                    })
                  }
                />
                <label>
                  <input
                    checked={item.enabled}
                    onChange={(e) =>
                      update((n) => {
                        n[kind][index]!.enabled = e.target.checked;
                      })
                    }
                    type="checkbox"
                  />{" "}
                  Show
                </label>
                <button
                  onClick={() =>
                    update((n) => {
                      n[kind].splice(index, 1);
                      n[kind].forEach((x, i) => (x.order = i));
                    })
                  }
                  type="button"
                >
                  Remove
                </button>
              </div>
            ))}
          </section>
        ))}
      </details>
      <details>
        <summary>Coverage</summary>
        <button
          className="platform-button platform-button--quiet"
          onClick={() => {
            const emirate = globalThis.prompt("Emirate")?.trim();
            if (emirate)
              update((n) =>
                n.coverage.push({
                  id: `coverage-${crypto.randomUUID().slice(0, 8)}`,
                  emirate,
                  enabled: true,
                  order: n.coverage.length,
                }),
              );
          }}
          type="button"
        >
          Add coverage area
        </button>
        {settings.coverage.map((item, index) => (
          <div className="website-editor__row" key={item.id}>
            <input
              aria-label="Emirate"
              value={item.emirate}
              onChange={(e) =>
                update((n) => {
                  n.coverage[index]!.emirate = e.target.value;
                })
              }
            />
            <input
              aria-label="Area"
              placeholder="Optional area"
              value={item.area ?? ""}
              onChange={(e) =>
                update((n) => {
                  n.coverage[index]!.area = e.target.value;
                })
              }
            />
            <label>
              <input
                checked={item.enabled}
                onChange={(e) =>
                  update((n) => {
                    n.coverage[index]!.enabled = e.target.checked;
                  })
                }
                type="checkbox"
              />{" "}
              Show
            </label>
          </div>
        ))}
      </details>
      <details>
        <summary>Contact, WhatsApp & location</summary>
        <div className="website-editor__grid">
          {(["phone", "mobile", "email", "whatsappNumber"] as const).map((key) => (
            <label className="platform-field" key={key}>
              <span>{key}</span>
              <input
                value={settings.contact[key] ?? ""}
                onChange={(e) =>
                  update((n) => {
                    n.contact[key] = e.target.value;
                  })
                }
              />
            </label>
          ))}
          <label className="platform-field">
            <span>Address EN</span>
            <input
              value={settings.contact.address?.en ?? ""}
              onChange={(e) =>
                update((n) => {
                  n.contact.address = { ...n.contact.address, en: e.target.value };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>City/Emirate</span>
            <input
              value={settings.contact.city?.en ?? ""}
              onChange={(e) =>
                update((n) => {
                  n.contact.city = { ...n.contact.city, en: e.target.value };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Latitude</span>
            <input
              type="number"
              value={settings.contact.latitude ?? ""}
              onChange={(e) =>
                update((n) => {
                  if (e.target.value) n.contact.latitude = Number(e.target.value);
                  else delete n.contact.latitude;
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Longitude</span>
            <input
              type="number"
              value={settings.contact.longitude ?? ""}
              onChange={(e) =>
                update((n) => {
                  if (e.target.value) n.contact.longitude = Number(e.target.value);
                  else delete n.contact.longitude;
                })
              }
            />
          </label>
        </div>
        <div className="website-editor__toggles">
          {(
            [
              "showPhone",
              "showEmail",
              "showWhatsapp",
              "showAddress",
              "showWorkingHours",
              "whatsappEnabled",
            ] as const
          ).map((key) => (
            <label key={key}>
              <input
                checked={settings.contact[key]}
                onChange={(e) =>
                  update((n) => {
                    n.contact[key] = e.target.checked;
                  })
                }
                type="checkbox"
              />{" "}
              {key}
            </label>
          ))}
        </div>
        <div className="platform-panel__header">
          <h5>Working hours</h5>
          <button
            className="platform-button platform-button--quiet"
            onClick={() => {
              const day = globalThis.prompt("Day (monday–sunday)")?.trim().toLowerCase();
              if (day)
                update((next) =>
                  next.contact.workingHours.push({
                    day,
                    closed: false,
                    opens: "09:00",
                    closes: "18:00",
                  }),
                );
            }}
            type="button"
          >
            Add day
          </button>
        </div>
        {settings.contact.workingHours.map((hours, index) => (
          <div className="website-editor__row" key={`${hours.day}-${index}`}>
            <strong>{hours.day}</strong>
            <label>
              <input
                checked={hours.closed}
                onChange={(event) =>
                  update((next) => {
                    next.contact.workingHours[index]!.closed = event.target.checked;
                  })
                }
                type="checkbox"
              />{" "}
              Closed
            </label>
            <input
              aria-label={`${hours.day} opens`}
              disabled={hours.closed}
              type="time"
              value={hours.opens ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.contact.workingHours[index]!.opens = event.target.value;
                })
              }
            />
            <input
              aria-label={`${hours.day} closes`}
              disabled={hours.closed}
              type="time"
              value={hours.closes ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.contact.workingHours[index]!.closes = event.target.value;
                })
              }
            />
          </div>
        ))}
      </details>
      <details open>
        <summary>Company Knowledge &amp; Agent</summary>
        <h5>Company Facts</h5>
        <div className="website-editor__grid">
          <label className="platform-field">
            <span>Public specialization / description EN</span>
            <textarea
              maxLength={2000}
              value={settings.knowledge.description?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.description = {
                    ...next.knowledge.description,
                    en: event.target.value,
                  };
                })
              }
            />
          </label>
          <label className="platform-field" dir="rtl">
            <span>Public description AR</span>
            <textarea
              maxLength={2000}
              value={settings.knowledge.description?.ar ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.description = {
                    ...next.knowledge.description,
                    ar: event.target.value,
                  };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Supported package types (comma separated)</span>
            <input
              value={settings.knowledge.packageTypes.join(", ")}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.packageTypes = event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean);
                })
              }
            />
          </label>
          <fieldset>
            <legend>Who do you serve?</legend>
            {(["ecommerce", "smes", "individuals", "corporate"] as const).map((audience) => (
              <label key={audience}>
                <input
                  checked={settings.knowledge.audiences.includes(audience)}
                  onChange={(event) =>
                    update((next) => {
                      next.knowledge.audiences = event.target.checked
                        ? [...new Set([...next.knowledge.audiences, audience])]
                        : next.knowledge.audiences.filter((value) => value !== audience);
                    })
                  }
                  type="checkbox"
                />{" "}
                {audience}
              </label>
            ))}
          </fieldset>
          <label className="platform-field">
            <span>Maximum weight (kg, optional)</span>
            <input
              min="0.01"
              step="0.01"
              type="number"
              value={settings.knowledge.maximumWeightKg ?? ""}
              onChange={(event) =>
                update((next) => {
                  const value = Number(event.target.value);
                  if (event.target.value) next.knowledge.maximumWeightKg = value;
                  else delete next.knowledge.maximumWeightKg;
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Fragile-items policy EN</span>
            <textarea
              value={settings.knowledge.fragilePolicy?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.fragilePolicy = {
                    ...next.knowledge.fragilePolicy,
                    en: event.target.value,
                  };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Prohibited / restricted items EN</span>
            <textarea
              value={settings.knowledge.prohibitedItems?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.prohibitedItems = {
                    ...next.knowledge.prohibitedItems,
                    en: event.target.value,
                  };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Size restrictions EN</span>
            <textarea
              value={settings.knowledge.sizeRestrictions?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.sizeRestrictions = {
                    ...next.knowledge.sizeRestrictions,
                    en: event.target.value,
                  };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Package preparation instructions EN</span>
            <textarea
              value={settings.knowledge.instructions.packagePreparation?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.instructions.packagePreparation = {
                    ...next.knowledge.instructions.packagePreparation,
                    en: event.target.value,
                  };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Pickup instructions EN</span>
            <textarea
              value={settings.knowledge.instructions.pickup?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.instructions.pickup = {
                    ...next.knowledge.instructions.pickup,
                    en: event.target.value,
                  };
                })
              }
            />
          </label>
          <label>
            <input
              checked={settings.knowledge.cod.supported}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.cod.supported = event.target.checked;
                })
              }
              type="checkbox"
            />{" "}
            COD supported
          </label>
          <label className="platform-field">
            <span>Public COD limitations EN</span>
            <textarea
              value={settings.knowledge.cod.limitations?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.cod.limitations = {
                    ...next.knowledge.cod.limitations,
                    en: event.target.value,
                  };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Pricing response</span>
            <select
              value={settings.knowledge.pricing.mode}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.pricing.mode = event.target.value as
                    "quote" | "request_confirmation" | "contact";
                })
              }
            >
              <option value="quote">Use quote function</option>
              <option value="request_confirmation">Request confirmation</option>
              <option value="contact">Contact Company</option>
            </select>
          </label>
          <label className="platform-field">
            <span>Approved pricing guidance EN</span>
            <textarea
              value={settings.knowledge.pricing.guidance?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.knowledge.pricing.guidance = {
                    ...next.knowledge.pricing.guidance,
                    en: event.target.value,
                  };
                })
              }
            />
          </label>
        </div>
        <div className="platform-panel__header">
          <h5>Public FAQs</h5>
          <button
            className="platform-button platform-button--quiet"
            onClick={() =>
              update((next) =>
                next.knowledge.faqs.push({
                  id: `faq-${crypto.randomUUID().slice(0, 8)}`,
                  question: { en: "New question" },
                  answer: { en: "Approved answer" },
                  enabled: true,
                  order: next.knowledge.faqs.length,
                  websiteVisible: true,
                  agentAvailable: true,
                }),
              )
            }
            type="button"
          >
            Add FAQ
          </button>
        </div>
        {settings.knowledge.faqs.map((faq, index) => (
          <div className="website-editor__grid" key={faq.id}>
            <label className="platform-field">
              <span>Question EN</span>
              <input
                value={faq.question.en ?? ""}
                onChange={(event) =>
                  update((next) => {
                    next.knowledge.faqs[index]!.question.en = event.target.value;
                  })
                }
              />
            </label>
            <label className="platform-field">
              <span>Answer EN</span>
              <textarea
                value={faq.answer.en ?? ""}
                onChange={(event) =>
                  update((next) => {
                    next.knowledge.faqs[index]!.answer.en = event.target.value;
                  })
                }
              />
            </label>
            <label className="platform-field" dir="rtl">
              <span>Question AR</span>
              <input
                value={faq.question.ar ?? ""}
                onChange={(event) =>
                  update((next) => {
                    next.knowledge.faqs[index]!.question.ar = event.target.value;
                  })
                }
              />
            </label>
            <label className="platform-field" dir="rtl">
              <span>Answer AR</span>
              <textarea
                value={faq.answer.ar ?? ""}
                onChange={(event) =>
                  update((next) => {
                    next.knowledge.faqs[index]!.answer.ar = event.target.value;
                  })
                }
              />
            </label>
            <label>
              <input
                checked={faq.enabled}
                onChange={(event) =>
                  update((next) => {
                    next.knowledge.faqs[index]!.enabled = event.target.checked;
                  })
                }
                type="checkbox"
              />{" "}
              Enabled
            </label>
            <label>
              <input
                checked={faq.websiteVisible}
                onChange={(event) =>
                  update((next) => {
                    next.knowledge.faqs[index]!.websiteVisible = event.target.checked;
                  })
                }
                type="checkbox"
              />{" "}
              Website visible
            </label>
            <label>
              <input
                checked={faq.agentAvailable}
                onChange={(event) =>
                  update((next) => {
                    next.knowledge.faqs[index]!.agentAvailable = event.target.checked;
                  })
                }
                type="checkbox"
              />{" "}
              Agent available
            </label>
            <button
              className="platform-button platform-button--danger"
              onClick={() =>
                update((next) => {
                  next.knowledge.faqs.splice(index, 1);
                  next.knowledge.faqs.forEach((item, order) => (item.order = order));
                })
              }
              type="button"
            >
              Remove FAQ
            </button>
          </div>
        ))}
        <h5>Agent Behavior</h5>
        <div className="website-editor__grid">
          <label>
            <input
              checked={settings.agent.enabled}
              onChange={(event) =>
                update((next) => {
                  next.agent.enabled = event.target.checked;
                })
              }
              type="checkbox"
            />{" "}
            Agent enabled
          </label>
          <label className="platform-field">
            <span>Agent display name</span>
            <input
              maxLength={100}
              value={settings.agent.displayName ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.agent.displayName = event.target.value;
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Tone</span>
            <select
              value={settings.agent.tone}
              onChange={(event) =>
                update((next) => {
                  next.agent.tone = event.target.value as typeof next.agent.tone;
                })
              }
            >
              <option value="professional">Professional</option>
              <option value="friendly_professional">Friendly Professional</option>
              <option value="concise">Concise</option>
              <option value="warm">Warm</option>
            </select>
          </label>
          <label className="platform-field">
            <span>Unknown-answer behavior</span>
            <select
              value={settings.agent.unknownBehavior}
              onChange={(event) =>
                update((next) => {
                  next.agent.unknownBehavior = event.target
                    .value as typeof next.agent.unknownBehavior;
                })
              }
            >
              <option value="safe_response">General safe response</option>
              <option value="whatsapp">Offer WhatsApp</option>
              <option value="contact">Offer phone/email</option>
              <option value="submit_request">Offer delivery request</option>
            </select>
          </label>
          <label className="platform-field">
            <span>Welcome message EN</span>
            <textarea
              value={settings.agent.welcomeMessage?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.agent.welcomeMessage = {
                    ...next.agent.welcomeMessage,
                    en: event.target.value,
                  };
                })
              }
            />
          </label>
          <label className="platform-field" dir="rtl">
            <span>Welcome message AR</span>
            <textarea
              value={settings.agent.welcomeMessage?.ar ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.agent.welcomeMessage = {
                    ...next.agent.welcomeMessage,
                    ar: event.target.value,
                  };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Human handoff message</span>
            <textarea
              value={settings.agent.handoffMessage?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.agent.handoffMessage = {
                    ...next.agent.handoffMessage,
                    en: event.target.value,
                  };
                })
              }
            />
          </label>
        </div>
        <div className="website-editor__toggles">
          {Object.keys(settings.agent.capabilities).map((key) => (
            <label key={key}>
              <input
                checked={
                  settings.agent.capabilities[key as keyof typeof settings.agent.capabilities]
                }
                onChange={(event) =>
                  update((next) => {
                    next.agent.capabilities[key as keyof typeof next.agent.capabilities] =
                      event.target.checked;
                  })
                }
                type="checkbox"
              />{" "}
              {key.replace(/([A-Z])/gu, " $1")}
            </label>
          ))}
        </div>
        <div className="website-editor__toggles">
          {(
            ["track", "request_delivery", "services", "coverage", "contact", "whatsapp"] as const
          ).map((action) => (
            <label key={action}>
              <input
                checked={settings.agent.suggestedActions.includes(action)}
                onChange={(event) =>
                  update((next) => {
                    next.agent.suggestedActions = event.target.checked
                      ? [...new Set([...next.agent.suggestedActions, action])]
                      : next.agent.suggestedActions.filter((item) => item !== action);
                  })
                }
                type="checkbox"
              />{" "}
              {action.replaceAll("_", " ")}
            </label>
          ))}
        </div>
      </details>
      <details>
        <summary>Social links</summary>
        <div className="website-editor__grid">
          {["instagram", "facebook", "tiktok", "linkedin", "x", "youtube"].map((key) => (
            <label className="platform-field" key={key}>
              <span>{key}</span>
              <input
                type="url"
                value={settings.socialLinks[key] ?? ""}
                onChange={(e) =>
                  update((n) => {
                    n.socialLinks[key] = e.target.value || undefined;
                  })
                }
              />
            </label>
          ))}
        </div>
      </details>
      <details>
        <summary>Public functions &amp; SEO</summary>
        <div className="website-editor__toggles">
          <label>
            <input
              checked={settings.functions?.trackingEnabled !== false}
              onChange={(event) =>
                update((next) => {
                  next.functions = {
                    ...(next.functions ?? { requestDeliveryEnabled: true }),
                    trackingEnabled: event.target.checked,
                  };
                })
              }
              type="checkbox"
            />{" "}
            Shipment tracking
          </label>
          <label>
            <input
              checked={settings.functions?.requestDeliveryEnabled !== false}
              onChange={(event) =>
                update((next) => {
                  next.functions = {
                    ...(next.functions ?? { trackingEnabled: true }),
                    requestDeliveryEnabled: event.target.checked,
                  };
                })
              }
              type="checkbox"
            />{" "}
            Request delivery
          </label>
          <label>
            <input
              checked={settings.seo?.indexable !== false}
              onChange={(event) =>
                update((next) => {
                  next.seo = { ...(next.seo ?? {}), indexable: event.target.checked };
                })
              }
              type="checkbox"
            />{" "}
            Allow search indexing
          </label>
        </div>
        <div className="website-editor__grid">
          <label className="platform-field">
            <span>SEO title (EN)</span>
            <input
              value={settings.seo?.title?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.seo = {
                    ...(next.seo ?? { indexable: true }),
                    title: { ...next.seo?.title, en: event.target.value },
                  };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>SEO description (EN)</span>
            <textarea
              value={settings.seo?.description?.en ?? ""}
              onChange={(event) =>
                update((next) => {
                  next.seo = {
                    ...(next.seo ?? { indexable: true }),
                    description: { ...next.seo?.description, en: event.target.value },
                  };
                })
              }
            />
          </label>
          <label className="platform-field">
            <span>Social image URL</span>
            <input
              type="url"
              value={settings.seo?.socialImageUrl ?? ""}
              onChange={(event) =>
                update((next) => {
                  const value = event.target.value;
                  next.seo = {
                    ...(next.seo ?? { indexable: true }),
                    ...(value ? { socialImageUrl: value } : {}),
                  };
                  if (!value) delete next.seo.socialImageUrl;
                })
              }
            />
          </label>
        </div>
      </details>
      <details>
        <summary>Sections</summary>
        {[...settings.sections]
          .sort((a, b) => a.order - b.order)
          .map((section, index) => (
            <div className="website-editor__row" key={section.key}>
              <label>
                <input
                  checked={section.enabled}
                  onChange={(e) =>
                    update((n) => {
                      n.sections.find((x) => x.key === section.key)!.enabled = e.target.checked;
                    })
                  }
                  type="checkbox"
                />{" "}
                {section.key.replaceAll("_", " ")}
              </label>
              <button disabled={index === 0} onClick={() => moveSection(index, -1)} type="button">
                Up
              </button>
              <button
                disabled={index === settings.sections.length - 1}
                onClick={() => moveSection(index, 1)}
                type="button"
              >
                Down
              </button>
            </div>
          ))}
      </details>
    </div>
  );
}
