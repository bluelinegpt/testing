import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { type CheckoutArea, searchAreas } from "../api/checkout-client.js";

/**
 * Pre-production fix: the Checkout's searchable Area selector.
 *
 * A standard ARIA 1.2 "combobox with list autocomplete" -- a text input
 * (`role="combobox"`) paired with a `role="listbox"` popup, not a bare
 * `<select>` (too long to scan for a UAE Area list) and not a free-text
 * field (the whole point of this fix is that Area is never free text). The
 * displayed text and the committed selection are two different pieces of
 * state on purpose: typing filters the list, but nothing is "selected"
 * until an option is actually chosen -- losing focus with unconfirmed text
 * reverts to the last real selection rather than silently submitting
 * whatever was typed (§4).
 */
export function AreaCombobox({
  disabled,
  emirateId,
  error,
  onChange,
  storeSlug,
  value,
}: {
  readonly disabled?: boolean;
  readonly emirateId: string | undefined;
  readonly error?: string | undefined;
  readonly onChange: (area: CheckoutArea | null) => void;
  readonly storeSlug: string;
  readonly value: CheckoutArea | null;
}) {
  const { i18n, t } = useTranslation();
  const listboxId = useId();
  const inputId = useId();
  const [query, setQuery] = useState(value === null ? "" : areaLabel(value, i18n.language));
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<readonly CheckoutArea[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const requestToken = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // A changed Emirate invalidates whatever Area was picked under the old
  // one (§2) -- the field resets rather than silently keeping a now-wrong
  // selection.
  useEffect(() => {
    setQuery("");
    onChange(null);
    setOptions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only Emirate changes should trigger this reset.
  }, [emirateId]);

  useEffect(() => {
    setQuery(value === null ? "" : areaLabel(value, i18n.language));
  }, [value, i18n.language]);

  useEffect(() => {
    if (!open || emirateId === undefined) return;
    const token = ++requestToken.current;
    setLoading(true);
    const timer = setTimeout(() => {
      void searchAreas({ emirateId, search: query, storeSlug }).then((result) => {
        if (requestToken.current !== token) return; // A newer keystroke already superseded this request.
        setOptions(result.items);
        setLoading(false);
        setActiveIndex(result.items.length > 0 ? 0 : -1);
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [open, query, emirateId, storeSlug]);

  function commit(area: CheckoutArea) {
    onChange(area);
    setQuery(areaLabel(area, i18n.language));
    setOpen(false);
    setActiveIndex(-1);
  }

  function revertToLastSelection() {
    setQuery(value === null ? "" : areaLabel(value, i18n.language));
    setOpen(false);
    setActiveIndex(-1);
  }

  return (
    <div className="store-field store-combobox">
      <label htmlFor={inputId}>{t("checkout.address.area")}</label>
      <input
        aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-invalid={error === undefined ? undefined : true}
        autoComplete="off"
        disabled={disabled ?? emirateId === undefined}
        id={inputId}
        onBlur={() => {
          // Deferred so a click on a listbox option (which blurs the input
          // first) still registers before the list is torn down.
          window.setTimeout(() => {
            if (document.activeElement?.closest(`#${CSS.escape(listboxId)}`) !== null) return;
            revertToLastSelection();
          }, 0);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          if (value !== null) onChange(null); // Typing invalidates the prior commit until a new one is made.
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActiveIndex((index) => Math.min(index + 1, options.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            const chosen = options[activeIndex];
            if (chosen !== undefined) commit(chosen);
          } else if (event.key === "Escape") {
            revertToLastSelection();
          }
        }}
        placeholder={
          emirateId === undefined
            ? t("checkout.address.areaChooseEmirateFirst")
            : t("checkout.address.searchArea")
        }
        ref={inputRef}
        role="combobox"
        value={query}
      />
      {error === undefined ? null : (
        <p className="store-field-error" role="alert">
          {error}
        </p>
      )}
      {open && emirateId !== undefined ? (
        <ul className="store-combobox__listbox" id={listboxId} role="listbox">
          {loading ? (
            <li className="store-combobox__status">{t("common.loading")}</li>
          ) : options.length === 0 ? (
            <li className="store-combobox__status">{t("checkout.address.noAreaResults")}</li>
          ) : (
            options.map((option, index) => (
              <li
                aria-selected={index === activeIndex}
                className={`store-combobox__option${index === activeIndex ? " store-combobox__option--active" : ""}`}
                id={`${listboxId}-${index}`}
                key={option.id}
                onMouseDown={(event) => {
                  // `onMouseDown`, not `onClick`: fires before the input's
                  // `onBlur`, so the commit is not lost to the revert.
                  event.preventDefault();
                  commit(option);
                }}
                onMouseEnter={() => setActiveIndex(index)}
                role="option"
              >
                {areaLabel(option, i18n.language)}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

function areaLabel(area: CheckoutArea, language: string): string {
  return language.startsWith("ar") && area.nameAr !== null && area.nameAr !== ""
    ? area.nameAr
    : area.nameEn;
}
