import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { VersionBadge } from "./VersionBadge.js";

export function Modal({
  children,
  className = "",
  closeLabel,
  onRequestClose,
  title,
  titleId,
}: {
  children: ReactNode;
  className?: string;
  closeLabel: string;
  onRequestClose: () => void;
  title: string;
  titleId: string;
}) {
  const hostRef = useRef<HTMLDialogElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onRequestClose);
  closeRef.current = onRequestClose;

  useEffect(() => {
    const host = hostRef.current;
    if (host !== null) {
      // Native modal dialogs are promoted into the browser's top layer. This
      // is stronger than any z-index and prevents floating assistants,
      // portalled menus, or transformed ancestors from covering the dialog.
      // jsdom and older embedded browsers may not implement showModal; the
      // open attribute keeps the existing fixed-backdrop behaviour as a safe
      // fallback there.
      if (typeof host.showModal === "function") host.showModal();
      else host.setAttribute("open", "");
    }
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    const dialog = dialogRef.current;
    const firstFocusable =
      dialog?.querySelector<HTMLElement>("[autofocus]") ??
      dialog?.querySelector<HTMLElement>(
        "input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]",
      ) ??
      dialog?.querySelector<HTMLElement>("button:not([disabled])");
    firstFocusable?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || dialog === null) return;
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]",
        ),
      ];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (host?.open && typeof host.close === "function") host.close();
      previouslyFocused?.focus();
    };
  }, []);

  return createPortal(
    <dialog
      aria-labelledby={titleId}
      aria-modal="true"
      className="modal-host"
      onCancel={(event) => {
        event.preventDefault();
        onRequestClose();
      }}
      ref={hostRef}
    >
      <div
        className="modal-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onRequestClose();
        }}
      >
        <section
          className={`modal ${className}`.trim()}
          ref={dialogRef}
        >
          <header className="modal-heading">
            <div className="modal-heading-title">
              <h2 id={titleId}>{title}</h2>
              <VersionBadge inline />
            </div>
            <button
              aria-label={closeLabel}
              className="close-button"
              onClick={onRequestClose}
              type="button"
            >
              <X aria-hidden="true" size={18} strokeWidth={2} />
            </button>
          </header>
          {children}
        </section>
      </div>
    </dialog>,
    document.body,
  );
}
