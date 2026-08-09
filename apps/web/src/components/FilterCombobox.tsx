import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export interface FilterComboboxOption {
  readonly id: string;
  /** What the operator reads. Identifiers do not belong here. */
  readonly label: string;
  /**
   * Extra text matched while typing but never displayed -- the record's code,
   * typically. Someone who knows "TRD-000002" can still type it and land on the
   * right row, without every row carrying a code nobody reads.
   */
  readonly searchText?: string | undefined;
}

/**
 * A searchable, clearable filter over a list already held in memory.
 *
 * Distinct from `SearchCombobox`, which queries an endpoint per keystroke. The
 * Trader and Driver filters are populated once with the whole list, so querying
 * a server to narrow it would add latency and a failure mode to a list already
 * sitting in the component. Filtering happens locally and instantly.
 *
 * Selection is by identifier and reported as a plain string, so this drops into
 * the same filter state a `<select>` fed.
 */
export function FilterCombobox({
  emptyText,
  label,
  onChange,
  options,
  placeholder,
  value,
}: {
  emptyText: string;
  label: string;
  onChange: (value: string) => void;
  options: readonly FilterComboboxOption[];
  placeholder?: string | undefined;
  value: string;
}) {
  const { t } = useTranslation();
  const selected = options.find((option) => option.id === value);
  const [query, setQuery] = useState("");
  const [typing, setTyping] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const blurTimer = useRef<number | undefined>(undefined);
  const listId = `filter-${label.replaceAll(/\s+/g, "-").toLowerCase()}-options`;

  /* While the operator is typing, the box shows what they typed. Otherwise it
     shows the current selection -- including after the selection is changed from
     outside, such as Clear Filters. */
  useEffect(() => {
    if (!typing) setQuery(selected?.label ?? "");
  }, [selected, typing]);

  useEffect(
    () => () => {
      if (blurTimer.current !== undefined) window.clearTimeout(blurTimer.current);
    },
    [],
  );

  const allLabel = t("operations.allLabel", { label });
  const matches = useMemo(() => {
    const term = query.trim().toLowerCase();
    // Not typing, or the box still shows the selection: offer the whole list
    // rather than only the one row that matches the selected label.
    if (!typing || term === "") return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(term) ||
        (option.searchText ?? "").toLowerCase().includes(term),
    );
  }, [options, query, typing]);

  const commit = (next: string) => {
    onChange(next);
    setTyping(false);
    setOpen(false);
  };

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.min(index + 1, matches.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!open) return;
      // Index 0 is the "All" row, so the options themselves start at 1.
      commit(activeIndex === 0 ? "" : (matches[activeIndex - 1]?.id ?? ""));
    } else if (event.key === "Escape") {
      setTyping(false);
      setOpen(false);
    }
  };

  return (
    <div className="search-combobox">
      <input
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        aria-label={label}
        autoComplete="off"
        onBlur={() => {
          // Deferred so a click on an option is not cancelled by the blur, and
          // the half-typed text reverts to the selection rather than lingering.
          blurTimer.current = window.setTimeout(() => {
            setTyping(false);
            setOpen(false);
          }, 120);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setTyping(true);
          setActiveIndex(0);
          setOpen(true);
        }}
        onFocus={() => {
          if (blurTimer.current !== undefined) window.clearTimeout(blurTimer.current);
          setOpen(true);
        }}
        onKeyDown={keyDown}
        placeholder={placeholder ?? allLabel}
        role="combobox"
        value={query}
      />
      {open ? (
        <div className="combobox-options" id={listId} role="listbox">
          <button
            aria-selected={activeIndex === 0}
            className={activeIndex === 0 ? "combobox-option active" : "combobox-option"}
            onClick={() => commit("")}
            onMouseDown={(event) => event.preventDefault()}
            role="option"
            type="button"
          >
            {allLabel}
          </button>
          {matches.length === 0 ? <div className="combobox-empty">{emptyText}</div> : null}
          {matches.map((option, index) => (
            <button
              aria-selected={index + 1 === activeIndex}
              className={index + 1 === activeIndex ? "combobox-option active" : "combobox-option"}
              key={option.id}
              onClick={() => commit(option.id)}
              onMouseDown={(event) => event.preventDefault()}
              role="option"
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
