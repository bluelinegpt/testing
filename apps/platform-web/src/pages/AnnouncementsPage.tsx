import { type FormEvent, type ReactElement, type ReactNode, useCallback, useEffect, useState } from "react";

import {
  type AnnouncementAudience,
  type AnnouncementDisplayStatus,
  type AnnouncementSurface,
  type AnnouncementType,
  type PlatformAnnouncement,
  type PlatformCompanySummary,
  type SaveAnnouncementPayload,
  platformApi,
} from "../api/platform-client.js";
import { usePlatformSession } from "../app/PlatformSession.js";

/**
 * Platform Administration -> Announcements.
 *
 * Banners shown to Companies -- "Upcoming maintenance on 14 October, 05:00" --
 * in English and Arabic, between a show-from and a show-until time, on the
 * screens chosen (office web app, Trader portal, mobile app), to every
 * Company or to chosen ones. Times are entered and shown in UAE time
 * (Asia/Dubai, UTC+4, no daylight saving) and sent to the API as UTC.
 */

const DUBAI_OFFSET_MINUTES = 4 * 60;

const typeOptions: readonly { value: AnnouncementType; label: string }[] = [
  { label: "Info (blue)", value: "info" },
  { label: "Warning (amber)", value: "warning" },
  { label: "Critical (red)", value: "critical" },
];

const surfaceOptions: readonly { value: AnnouncementSurface; label: string }[] = [
  { label: "Company web app (office)", value: "office_web" },
  { label: "Trader portal", value: "trader_portal" },
  { label: "Mobile app (drivers and staff)", value: "mobile_app" },
];

const surfaceShort: Readonly<Record<AnnouncementSurface, string>> = {
  mobile_app: "Mobile",
  office_web: "Office web",
  trader_portal: "Trader portal",
};

const statusLabel: Readonly<Record<AnnouncementDisplayStatus, string>> = {
  cancelled: "Cancelled",
  ended: "Ended",
  live: "Live",
  scheduled: "Scheduled",
};

/** Server error codes, explained. */
const problemText: Readonly<Record<string, string>> = {
  arabic_incomplete: "The Arabic text needs both a title and a message.",
  audience_invalid: "Choose who should see it.",
  body_too_long: "Messages can be at most 600 characters.",
  companies_required: "Choose at least one Company, or send it to all Companies.",
  dates_invalid: "Enter both Show from and Show until.",
  dates_out_of_order: "Show until must be after Show from.",
  english_incomplete: "The English text needs both a title and a message.",
  language_required: "Write the announcement in English, Arabic or both.",
  surfaces_required: "Choose at least one place to show it.",
  title_too_long: "Titles can be at most 120 characters.",
  until_in_past: "Show until is already in the past, so nobody would see it.",
};

interface Draft {
  type: AnnouncementType;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
  /** `YYYY-MM-DDTHH:mm`, UAE time. */
  showFrom: string;
  showUntil: string;
  surfaces: AnnouncementSurface[];
  audience: AnnouncementAudience;
  companies: { id: string; nameEn: string }[];
}

/** `YYYY-MM-DDTHH:mm` in UAE time for an instant. */
export function toDubaiInput(instant: Date): string {
  const shifted = new Date(instant.getTime() + DUBAI_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 16);
}

/** A UAE-time `YYYY-MM-DDTHH:mm` as a UTC ISO instant; null when incomplete. */
export function fromDubaiInput(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) return null;
  const [, year, month, day, hour, minute] = match.map(Number) as unknown as number[];
  const utc = Date.UTC(year!, month! - 1, day!, hour!, minute!) - DUBAI_OFFSET_MINUTES * 60_000;
  return Number.isNaN(utc) ? null : new Date(utc).toISOString();
}

/** "14 Oct 2026, 05:00" in UAE time. */
function dubaiText(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: "Asia/Dubai",
    year: "numeric",
  }).format(new Date(iso));
}

function blankDraft(): Draft {
  const start = new Date();
  start.setUTCMinutes(0, 0, 0);
  start.setUTCHours(start.getUTCHours() + 1);
  return {
    audience: "all_companies",
    bodyAr: "",
    bodyEn: "",
    companies: [],
    showFrom: toDubaiInput(start),
    showUntil: toDubaiInput(new Date(start.getTime() + 24 * 3_600_000)),
    surfaces: ["office_web"],
    titleAr: "",
    titleEn: "",
    type: "warning",
  };
}

function draftFrom(announcement: PlatformAnnouncement): Draft {
  return {
    audience: announcement.audience,
    bodyAr: announcement.bodyAr ?? "",
    bodyEn: announcement.bodyEn ?? "",
    companies: announcement.companies.map((company) => ({ ...company })),
    showFrom: toDubaiInput(new Date(announcement.showFrom)),
    showUntil: toDubaiInput(new Date(announcement.showUntil)),
    surfaces: [...announcement.surfaces],
    titleAr: announcement.titleAr ?? "",
    titleEn: announcement.titleEn ?? "",
    type: announcement.type,
  };
}

/** The same checks the API runs, so the screen can explain before saving. */
export function draftProblems(draft: Draft, now: Date = new Date()): string[] {
  const problems: string[] = [];
  const en = [draft.titleEn.trim(), draft.bodyEn.trim()];
  const ar = [draft.titleAr.trim(), draft.bodyAr.trim()];
  if ((en[0] === "") !== (en[1] === "")) problems.push("english_incomplete");
  if ((ar[0] === "") !== (ar[1] === "")) problems.push("arabic_incomplete");
  if (en[0] === "" && ar[0] === "") problems.push("language_required");
  if (draft.titleEn.trim().length > 120 || draft.titleAr.trim().length > 120)
    problems.push("title_too_long");
  if (draft.bodyEn.trim().length > 600 || draft.bodyAr.trim().length > 600)
    problems.push("body_too_long");
  const from = fromDubaiInput(draft.showFrom);
  const until = fromDubaiInput(draft.showUntil);
  if (from === null || until === null) problems.push("dates_invalid");
  else if (until <= from) problems.push("dates_out_of_order");
  else if (new Date(until).getTime() <= now.getTime()) problems.push("until_in_past");
  if (draft.surfaces.length === 0) problems.push("surfaces_required");
  if (draft.audience === "selected_companies" && draft.companies.length === 0)
    problems.push("companies_required");
  return [...new Set(problems)];
}

function payloadFrom(draft: Draft): SaveAnnouncementPayload {
  const optional = (value: string) => (value.trim() === "" ? null : value.trim());
  return {
    audience: draft.audience,
    bodyAr: optional(draft.bodyAr),
    bodyEn: optional(draft.bodyEn),
    companyIds: draft.audience === "selected_companies" ? draft.companies.map((c) => c.id) : [],
    showFrom: fromDubaiInput(draft.showFrom) ?? "",
    showUntil: fromDubaiInput(draft.showUntil) ?? "",
    surfaces: draft.surfaces,
    titleAr: optional(draft.titleAr),
    titleEn: optional(draft.titleEn),
    type: draft.type,
  };
}

/** The banner as Company users will see it, in one language. */
export function AnnouncementBannerPreview({
  body,
  language,
  title,
  type,
}: {
  body: string;
  language: "en" | "ar";
  title: string;
  type: AnnouncementType;
}): ReactElement {
  const icon = type === "info" ? "ℹ" : type === "warning" ? "⚠" : "⛔";
  return (
    <div
      className={`announcement-preview announcement-preview--${type}`}
      dir={language === "ar" ? "rtl" : "ltr"}
      lang={language}
    >
      <span aria-hidden="true" className="announcement-preview__icon">
        {icon}
      </span>
      <p>
        <strong>{title === "" ? (language === "ar" ? "العنوان" : "Title") : title}</strong>{" "}
        {body === "" ? (language === "ar" ? "نص الرسالة" : "Message") : body}
      </p>
      <span aria-hidden="true" className="announcement-preview__close">
        ×
      </span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <label className="platform-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function CompanyPicker({
  selected,
  onChange,
}: {
  selected: readonly { id: string; nameEn: string }[];
  onChange: (next: { id: string; nameEn: string }[]) => void;
}): ReactElement {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<readonly PlatformCompanySummary[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      platformApi
        .companies({ pageSize: 20, search })
        .then((page) => {
          if (active) setResults(page.items);
        })
        .catch(() => {
          if (active) setError("Companies could not be loaded.");
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [search]);

  const chosen = new Set(selected.map((company) => company.id));
  return (
    <div className="announcement-companies">
      {selected.length === 0 ? (
        <p className="platform-muted">No Company chosen yet.</p>
      ) : (
        <ul aria-label="Chosen Companies" className="announcement-companies__chosen">
          {selected.map((company) => (
            <li key={company.id}>
              {company.nameEn}
              <button
                aria-label={`Remove ${company.nameEn}`}
                className="platform-button platform-button--quiet"
                onClick={() => onChange(selected.filter((item) => item.id !== company.id))}
                type="button"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <Field label="Find a Company">
        <input
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Company name or code"
          value={search}
        />
      </Field>
      {error === "" ? null : <p role="alert">{error}</p>}
      <ul className="announcement-companies__results">
        {results
          .filter((company) => !chosen.has(company.id))
          .map((company) => (
            <li key={company.id}>
              <span>
                {company.nameEn} <span className="platform-muted">{company.code}</span>
              </span>
              <button
                aria-label={`Add ${company.nameEn}`}
                className="platform-button platform-button--quiet"
                onClick={() => onChange([...selected, { id: company.id, nameEn: company.nameEn }])}
                type="button"
              >
                Add
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}

function Editor({
  editing,
  onCancel,
  onSaved,
}: {
  editing: PlatformAnnouncement | null;
  onCancel: () => void;
  onSaved: (saved: PlatformAnnouncement) => void;
}): ReactElement {
  const [draft, setDraft] = useState<Draft>(() => (editing === null ? blankDraft() : draftFrom(editing)));
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const problems = draftProblems(draft);
  const update = (change: Partial<Draft>) => setDraft((current) => ({ ...current, ...change }));

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setAttempted(true);
    setError("");
    if (problems.length > 0) return;
    if (
      draft.type === "critical" &&
      draft.audience === "all_companies" &&
      !window.confirm("Show a CRITICAL (red) announcement to every Company?")
    )
      return;
    setSaving(true);
    try {
      const payload = payloadFrom(draft);
      onSaved(
        editing === null
          ? await platformApi.createAnnouncement(payload)
          : await platformApi.updateAnnouncement(editing.id, payload),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The announcement could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      aria-label={editing === null ? "New announcement" : "Edit announcement"}
      className="platform-card announcement-editor"
      onSubmit={(event) => void save(event)}
    >
      <h3>{editing === null ? "New announcement" : "Edit announcement"}</h3>
      {editing === null ? null : (
        <p className="platform-muted">
          Saving shows it again to users who had closed it.
        </p>
      )}
      <fieldset className="announcement-editor__types">
        <legend>Type</legend>
        {typeOptions.map((option) => (
          <label key={option.value}>
            <input
              checked={draft.type === option.value}
              name="announcement-type"
              onChange={() => update({ type: option.value })}
              type="radio"
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      <div className="announcement-editor__languages">
        <div>
          <Field label="English title">
            <input
              maxLength={120}
              onChange={(event) => update({ titleEn: event.target.value })}
              placeholder="Upcoming maintenance"
              value={draft.titleEn}
            />
          </Field>
          <Field label="English message">
            <textarea
              maxLength={600}
              onChange={(event) => update({ bodyEn: event.target.value })}
              placeholder="We will be upgrading the system on 14 October, 05:00-06:00 (UAE time)."
              rows={3}
              value={draft.bodyEn}
            />
          </Field>
        </div>
        <div dir="rtl" lang="ar">
          <Field label="العنوان بالعربية (Arabic title)">
            <input
              maxLength={120}
              onChange={(event) => update({ titleAr: event.target.value })}
              placeholder="صيانة مجدولة"
              value={draft.titleAr}
            />
          </Field>
          <Field label="الرسالة بالعربية (Arabic message)">
            <textarea
              maxLength={600}
              onChange={(event) => update({ bodyAr: event.target.value })}
              placeholder="سنقوم بتحديث النظام يوم 14 أكتوبر من 5:00 إلى 6:00 صباحاً بتوقيت الإمارات."
              rows={3}
              value={draft.bodyAr}
            />
          </Field>
        </div>
      </div>
      <div className="announcement-editor__dates">
        <Field label="Show from (UAE time)">
          <input
            onChange={(event) => update({ showFrom: event.target.value })}
            type="datetime-local"
            value={draft.showFrom}
          />
        </Field>
        <Field label="Show until (UAE time)">
          <input
            onChange={(event) => update({ showUntil: event.target.value })}
            type="datetime-local"
            value={draft.showUntil}
          />
        </Field>
      </div>
      <p className="platform-muted">
        These control when the banner is visible. Write the maintenance time itself in the message.
      </p>
      <fieldset>
        <legend>Where to show it</legend>
        {surfaceOptions.map((option) => (
          <label key={option.value}>
            <input
              checked={draft.surfaces.includes(option.value)}
              onChange={(event) =>
                update({
                  surfaces: event.target.checked
                    ? [...draft.surfaces, option.value]
                    : draft.surfaces.filter((surface) => surface !== option.value),
                })
              }
              type="checkbox"
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Who sees it</legend>
        <label>
          <input
            checked={draft.audience === "all_companies"}
            name="announcement-audience"
            onChange={() => update({ audience: "all_companies" })}
            type="radio"
          />
          All Companies
        </label>
        <label>
          <input
            checked={draft.audience === "selected_companies"}
            name="announcement-audience"
            onChange={() => update({ audience: "selected_companies" })}
            type="radio"
          />
          Selected Companies
        </label>
        {draft.audience === "selected_companies" ? (
          <CompanyPicker onChange={(companies) => update({ companies })} selected={draft.companies} />
        ) : null}
      </fieldset>
      <section aria-label="Preview" className="announcement-editor__preview">
        <h4>Preview</h4>
        <AnnouncementBannerPreview
          body={draft.bodyEn.trim()}
          language="en"
          title={draft.titleEn.trim()}
          type={draft.type}
        />
        <AnnouncementBannerPreview
          body={draft.bodyAr.trim()}
          language="ar"
          title={draft.titleAr.trim()}
          type={draft.type}
        />
      </section>
      {attempted && problems.length > 0 ? (
        <ul className="platform-alert platform-alert--warning" role="alert">
          {problems.map((problem) => (
            <li key={problem}>{problemText[problem] ?? problem}</li>
          ))}
        </ul>
      ) : null}
      {error === "" ? null : (
        <p className="platform-alert" role="alert">
          {error}
        </p>
      )}
      <div className="announcement-editor__actions">
        <button className="platform-button" disabled={saving} type="submit">
          {saving ? "Saving…" : editing === null ? "Create announcement" : "Save changes"}
        </button>
        <button className="platform-button platform-button--quiet" onClick={onCancel} type="button">
          Close
        </button>
      </div>
    </form>
  );
}

export function AnnouncementsPage(): ReactElement {
  const session = usePlatformSession();
  const canManage = session.can("platform.announcements.manage");
  const [items, setItems] = useState<readonly PlatformAnnouncement[]>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<{ editing: PlatformAnnouncement | null } | null>(null);

  const load = useCallback(() => {
    setError("");
    platformApi
      .announcements()
      .then(setItems)
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : "Announcements could not be loaded."),
      );
  }, []);
  useEffect(load, [load]);

  async function act(
    announcement: PlatformAnnouncement,
    action: "end" | "cancel",
  ): Promise<void> {
    const question =
      action === "end"
        ? "Stop showing this announcement now?"
        : "Cancel this announcement? It will no longer show and cannot be edited.";
    if (!window.confirm(question)) return;
    try {
      if (action === "end") await platformApi.endAnnouncementNow(announcement.id);
      else await platformApi.cancelAnnouncement(announcement.id);
      setNotice(action === "end" ? "Announcement ended." : "Announcement cancelled.");
      load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The announcement could not be changed.");
    }
  }

  return (
    <section className="platform-panel announcements-page">
      <div className="platform-panel__header">
        <div>
          <h2>Announcements</h2>
          <p className="platform-muted">
            Banners at the top of the Company screens, for example planned maintenance or a new
            release. Users can close a banner; it shows again at their next sign-in.
          </p>
        </div>
        {canManage && editor === null ? (
          <button className="platform-button" onClick={() => setEditor({ editing: null })} type="button">
            New announcement
          </button>
        ) : null}
      </div>
      {notice === "" ? null : (
        <p className="platform-alert platform-alert--success" role="status">
          {notice}
        </p>
      )}
      {editor === null ? null : (
        <Editor
          editing={editor.editing}
          key={editor.editing?.id ?? "new"}
          onCancel={() => setEditor(null)}
          onSaved={(saved) => {
            setEditor(null);
            setNotice(
              saved.displayStatus === "live"
                ? "Saved. It is showing now."
                : `Saved. It will show from ${dubaiText(saved.showFrom)} (UAE time).`,
            );
            load();
          }}
        />
      )}
      {error === "" ? null : (
        <p className="platform-alert" role="alert">
          {error}
        </p>
      )}
      {items === undefined ? (
        error === "" ? (
          <p>Loading…</p>
        ) : (
          <button className="platform-button platform-button--quiet" onClick={load} type="button">
            Retry
          </button>
        )
      ) : (
        <div className="platform-table-scroll">
          <table className="platform-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Title</th>
                <th>Where</th>
                <th>Who</th>
                <th>Shows (UAE time)</th>
                <th>Status</th>
                {canManage ? <th>Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={canManage ? 7 : 6}>No announcements yet.</td>
                </tr>
              ) : (
                items.map((item) => {
                  const title = item.titleEn ?? item.titleAr ?? "";
                  const open = item.displayStatus === "live" || item.displayStatus === "scheduled";
                  return (
                    <tr key={item.id}>
                      <td>
                        <span className={`platform-badge announcement-badge--${item.type}`}>
                          {item.type === "info" ? "Info" : item.type === "warning" ? "Warning" : "Critical"}
                        </span>
                      </td>
                      <td>{title}</td>
                      <td>{item.surfaces.map((surface) => surfaceShort[surface]).join(", ")}</td>
                      <td>
                        {item.audience === "all_companies"
                          ? "All Companies"
                          : item.companies.length === 1
                            ? item.companies[0]!.nameEn
                            : `${item.companies.length} Companies`}
                      </td>
                      <td>
                        {dubaiText(item.showFrom)} – {dubaiText(item.showUntil)}
                      </td>
                      <td>
                        <span className={`platform-badge announcement-status--${item.displayStatus}`}>
                          {statusLabel[item.displayStatus]}
                        </span>
                      </td>
                      {canManage ? (
                        <td className="announcement-actions">
                          {item.status === "active" ? (
                            <button
                              aria-label={`Edit ${title}`}
                              className="platform-button platform-button--quiet"
                              onClick={() => setEditor({ editing: item })}
                              type="button"
                            >
                              Edit
                            </button>
                          ) : null}
                          {open ? (
                            <button
                              aria-label={`End ${title} now`}
                              className="platform-button platform-button--quiet"
                              onClick={() => void act(item, "end")}
                              type="button"
                            >
                              End now
                            </button>
                          ) : null}
                          {item.status === "active" ? (
                            <button
                              aria-label={`Cancel ${title}`}
                              className="platform-button platform-button--danger"
                              onClick={() => void act(item, "cancel")}
                              type="button"
                            >
                              Cancel
                            </button>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
