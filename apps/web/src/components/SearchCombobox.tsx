import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ApiClient } from "../api/api-client.js";
import type { SearchPage } from "../api/contracts.js";

export interface SearchOption {
  readonly id: string;
}

/** Production search debounce. Tests may pass 0 to remove the real-time wait. */
export const defaultSearchDebounceMs = 200;

export function SearchCombobox<T extends SearchOption>({
  api,
  autoFocus,
  debounceMs = defaultSearchDebounceMs,
  emptyText,
  getLabel,
  getSelectedLabel,
  label,
  onChange,
  path,
  placeholder,
  value,
}: {
  api: ApiClient;
  autoFocus?: boolean;
  debounceMs?: number;
  emptyText: string;
  getLabel: (option: T) => string;
  getSelectedLabel?: ((option: T) => string) | undefined;
  label: string;
  onChange: (option: T | undefined) => void;
  path: string;
  placeholder: string;
  value: T | undefined;
}) {
  const { t } = useTranslation();
  const selectedLabel = getSelectedLabel ?? getLabel;
  const [query, setQuery] = useState(value === undefined ? "" : selectedLabel(value));
  const [options, setOptions] = useState<readonly T[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const blurTimer = useRef<number | undefined>(undefined);
  const listId = `${path.replaceAll("/", "-")}-options`;

  useEffect(() => {
    if (value !== undefined) setQuery(selectedLabel(value));
  }, [selectedLabel, value]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      const separator = path.includes("?") ? "&" : "?";
      void api
        .get<SearchPage<T>>(
          `${path}${separator}search=${encodeURIComponent(query)}&limit=20&offset=0`,
          controller.signal,
        )
        .then((page) => {
          // A superseded search must never overwrite a newer one. Aborting the
          // request is not sufficient on its own: abort() does not reject a
          // response that has already resolved, so a stale reply can still land
          // after a newer query and blank the list. Gate every state write on
          // this request still being the current one.
          if (controller.signal.aborted) return;
          setOptions(page.items);
          setHasMore(page.hasMore);
          setActiveIndex(0);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          if (!(error instanceof DOMException && error.name === "AbortError")) setOptions([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, debounceMs);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [api, debounceMs, open, path, query]);

  const select = (option: T) => {
    onChange(option);
    setQuery(selectedLabel(option));
    setOpen(false);
  };

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.min(index + 1, Math.max(options.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && open && options[activeIndex] !== undefined) {
      event.preventDefault();
      select(options[activeIndex]);
    } else if (event.key === "Escape") {
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
        aria-required="true"
        autoComplete="off"
        autoFocus={autoFocus}
        onBlur={() => {
          blurTimer.current = window.setTimeout(() => setOpen(false), 120);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          onChange(undefined);
          setOpen(true);
        }}
        onFocus={() => {
          if (blurTimer.current !== undefined) window.clearTimeout(blurTimer.current);
          setOpen(true);
        }}
        onKeyDown={keyDown}
        placeholder={placeholder}
        role="combobox"
        value={query}
      />
      {open ? (
        <div className="combobox-options" id={listId} role="listbox">
          {loading ? <div className="combobox-empty">{t("common.loading")}</div> : null}
          {!loading && options.length === 0 ? (
            <div className="combobox-empty">{emptyText}</div>
          ) : null}
          {options.map((option, index) => (
            <button
              aria-selected={index === activeIndex}
              className={index === activeIndex ? "combobox-option active" : "combobox-option"}
              key={option.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(option)}
              role="option"
              type="button"
            >
              {getLabel(option)}
            </button>
          ))}
          {!loading && hasMore ? (
            <button
              className="combobox-option"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setLoading(true);
                void api
                  .get<SearchPage<T>>(
                    `${path}${path.includes("?") ? "&" : "?"}search=${encodeURIComponent(query)}&limit=20&offset=${options.length}`,
                  )
                  .then((page) => {
                    setOptions((current) => [...current, ...page.items]);
                    setHasMore(page.hasMore);
                  })
                  .catch(() => setHasMore(false))
                  .finally(() => setLoading(false));
              }}
              type="button"
            >
              {t("operations.loadMore")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
