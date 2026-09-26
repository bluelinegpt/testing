import { createContext, useContext, useEffect } from "react";

/**
 * Focus mode for the Accounting workspace: while a single record, editor or
 * report is open, the internal Accounting navigation is hidden and the
 * content takes the full width, so wide financial tables are readable without
 * horizontal scrolling. Leaving that screen (Back) restores the normal
 * two-column layout.
 *
 * Most screens are route-driven and are resolved by `AccountingWorkspace`
 * itself. This context exists for the cases a route cannot express — notably
 * the inline "Create" editors, which open as local state on a list screen.
 */
export const AccountingFocusContext = createContext<(focused: boolean) => void>(() => {});

/** Requests focus mode while `active` is true, releasing it on unmount. */
export function useAccountingFocus(active: boolean): void {
  const setFocused = useContext(AccountingFocusContext);
  useEffect(() => {
    setFocused(active);
    return () => setFocused(false);
  }, [active, setFocused]);
}
